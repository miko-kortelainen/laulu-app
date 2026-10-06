create table public.user_quotas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_daily integer not null check (chat_daily >= 0),
  analysis_daily integer not null check (analysis_daily >= 0),
  generation_daily integer not null check (generation_daily >= 0),
  storage_bytes bigint not null check (storage_bytes between 0 and 9007199254740991)
);

create table public.daily_usage (
  user_id uuid not null references public.user_quotas(user_id) on delete cascade,
  usage_date date not null,
  operation text not null check (operation in ('chat', 'analysis', 'generation')),
  used integer not null check (used > 0),
  primary key (user_id, usage_date, operation)
);

create table public.usage_reservations (
  id uuid primary key,
  user_id uuid not null references public.user_quotas(user_id) on delete cascade,
  usage_date date not null,
  operation text not null check (operation in ('chat', 'analysis', 'generation')),
  storage_bytes bigint not null default 0 check (storage_bytes between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  check (operation = 'generation' or storage_bytes = 0)
);

create index usage_reserved_storage on public.usage_reservations(user_id) where storage_bytes > 0;

alter table public.user_quotas enable row level security;
alter table public.daily_usage enable row level security;
alter table public.usage_reservations enable row level security;
revoke all on public.user_quotas, public.daily_usage, public.usage_reservations from public, anon, authenticated;
grant select, insert, update, delete on public.user_quotas, public.daily_usage, public.usage_reservations to service_role;

-- Every reservation and song insertion locks this same per-user row.
create function public.quota_account(p_user_id uuid, p_defaults jsonb)
returns public.user_quotas
language plpgsql security invoker set search_path = '' as $$
declare
  account public.user_quotas;
begin
  insert into public.user_quotas values (
    p_user_id, (p_defaults->>'chat_daily')::integer, (p_defaults->>'analysis_daily')::integer,
    (p_defaults->>'generation_daily')::integer, (p_defaults->>'storage_bytes')::bigint
  ) on conflict (user_id) do nothing;
  select * into strict account from public.user_quotas where user_id = p_user_id for update;
  return account;
end;
$$;

create function public.reserve_usage(p_user_id uuid, p_operation text, p_id uuid, p_storage_bytes bigint, p_defaults jsonb)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  account public.user_quotas;
  existing public.usage_reservations;
  day date;
  allowance integer;
  used_count integer;
  stored bigint;
  reserved bigint;
begin
  if p_operation is null or p_operation not in ('chat', 'analysis', 'generation') or p_id is null or
      p_storage_bytes is null or p_storage_bytes < 0 or (p_operation <> 'generation' and p_storage_bytes <> 0) then
    raise exception 'invalid reservation';
  end if;
  account := public.quota_account(p_user_id, p_defaults);
  -- Use the database date after waiting for the lock, including a midnight crossing.
  day := (clock_timestamp() at time zone 'UTC')::date;
  select * into existing from public.usage_reservations where id = p_id;
  if found then
    if existing.user_id <> p_user_id or existing.operation <> p_operation then
      raise exception 'reservation belongs to another operation';
    end if;
    return jsonb_build_object('allowed', true, 'id', p_id, 'created', false);
  end if;
  allowance := case p_operation when 'chat' then account.chat_daily
    when 'analysis' then account.analysis_daily else account.generation_daily end;
  select used into used_count from public.daily_usage
    where user_id = p_user_id and usage_date = day and operation = p_operation;
  if coalesce(used_count, 0) >= allowance then
    return jsonb_build_object('allowed', false, 'resource', p_operation,
      'resetAt', (day + 1)::timestamp at time zone 'UTC');
  end if;
  if p_storage_bytes > 0 then
    select coalesce(sum(size_bytes), 0) into stored from public.songs where owner_id = p_user_id;
    select coalesce(sum(storage_bytes), 0) into reserved from public.usage_reservations
      where user_id = p_user_id and storage_bytes > 0;
    if stored + reserved > account.storage_bytes - p_storage_bytes then
      return jsonb_build_object('allowed', false, 'resource', 'storage');
    end if;
  end if;
  insert into public.usage_reservations(id, user_id, usage_date, operation, storage_bytes)
    values (p_id, p_user_id, day, p_operation, p_storage_bytes);
  insert into public.daily_usage values (p_user_id, day, p_operation, 1)
    on conflict (user_id, usage_date, operation) do update set used = public.daily_usage.used + 1;
  return jsonb_build_object('allowed', true, 'id', p_id, 'created', true);
end;
$$;

-- ponytail: charge attempts at reservation, including lost responses; add dispatch states if pre-dispatch refunds are required.
create function public.release_song_reservation(p_user_id uuid, p_id uuid)
returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.user_quotas where user_id = p_user_id for update;
  update public.usage_reservations set storage_bytes = 0
    where id = p_id and user_id = p_user_id and operation = 'generation'
      and not exists (select 1 from public.songs where id = p_id);
end;
$$;

-- Insert pending metadata and replace its storage reservation with exact bytes in one transaction.
create function public.prepare_song_save(p_song jsonb, p_defaults jsonb)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  song public.songs;
  existing public.songs;
  account public.user_quotas;
  stored bigint;
  reserved bigint;
begin
  song := jsonb_populate_record(null::public.songs, p_song);
  if song.id is null or song.owner_id is null or song.size_bytes is null or song.size_bytes <= 0 or song.status <> 'pending' then
    raise exception 'invalid song metadata';
  end if;
  account := public.quota_account(song.owner_id, p_defaults);
  select * into existing from public.songs where id = song.id;
  if found then
    if existing.owner_id <> song.owner_id or existing.object_key <> song.object_key or existing.size_bytes <> song.size_bytes then
      raise exception 'song metadata does not match';
    end if;
    return jsonb_build_object('allowed', true, 'song', to_jsonb(existing));
  end if;
  if exists (select 1 from public.usage_reservations where id = song.id
      and (user_id <> song.owner_id or operation <> 'generation')) then
    raise exception 'reservation belongs to another operation';
  end if;
  select coalesce(sum(size_bytes), 0) into stored from public.songs where owner_id = song.owner_id;
  select coalesce(sum(storage_bytes), 0) into reserved from public.usage_reservations
    where user_id = song.owner_id and storage_bytes > 0 and id <> song.id;
  if stored + reserved > account.storage_bytes - song.size_bytes then
    return jsonb_build_object('allowed', false, 'resource', 'storage');
  end if;
  insert into public.songs select song.*;
  update public.usage_reservations set storage_bytes = 0 where id = song.id and user_id = song.owner_id;
  return jsonb_build_object('allowed', true, 'song', to_jsonb(song));
end;
$$;

create function public.get_usage(p_user_id uuid, p_defaults jsonb)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  account public.user_quotas;
  day date;
  counts jsonb;
  stored bigint;
  reserved bigint;
  result jsonb;
  operation text;
  allowance integer;
  used_count integer;
begin
  account := public.quota_account(p_user_id, p_defaults);
  day := (clock_timestamp() at time zone 'UTC')::date;
  select jsonb_object_agg(d.operation, d.used) into counts from public.daily_usage d
    where d.user_id = p_user_id and d.usage_date = day;
  result := jsonb_build_object('resetAt', (day + 1)::timestamp at time zone 'UTC');
  foreach operation in array array['chat', 'analysis', 'generation'] loop
    allowance := case operation when 'chat' then account.chat_daily
      when 'analysis' then account.analysis_daily else account.generation_daily end;
    used_count := coalesce((counts->>operation)::integer, 0);
    result := result || jsonb_build_object(operation, jsonb_build_object(
      'limit', allowance, 'used', used_count, 'remaining', greatest(0, allowance - used_count)));
  end loop;
  select coalesce(sum(size_bytes), 0) into stored from public.songs where owner_id = p_user_id;
  select coalesce(sum(storage_bytes), 0) into reserved from public.usage_reservations
    where user_id = p_user_id and storage_bytes > 0;
  return result || jsonb_build_object('storage', jsonb_build_object('limit', account.storage_bytes,
    'used', stored, 'reserved', reserved, 'remaining', greatest(0, account.storage_bytes - stored - reserved)));
end;
$$;

revoke all on function public.quota_account(uuid, jsonb),
  public.reserve_usage(uuid, text, uuid, bigint, jsonb), public.release_song_reservation(uuid, uuid),
  public.prepare_song_save(jsonb, jsonb), public.get_usage(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.quota_account(uuid, jsonb),
  public.reserve_usage(uuid, text, uuid, bigint, jsonb), public.release_song_reservation(uuid, uuid),
  public.prepare_song_save(jsonb, jsonb), public.get_usage(uuid, jsonb) to service_role;
