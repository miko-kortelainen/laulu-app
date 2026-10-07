create table public.global_usage (
  operation text primary key check (operation in ('chat', 'analysis', 'generation')),
  usage_date date not null,
  used integer not null check (used >= 0)
);

-- Include today's existing usage when enabling the shared ceiling.
insert into public.global_usage
select operations.operation, (clock_timestamp() at time zone 'UTC')::date, coalesce(sum(d.used), 0)
from unnest(array['chat', 'analysis', 'generation']) as operations(operation)
left join public.daily_usage d on d.operation = operations.operation
  and d.usage_date = (clock_timestamp() at time zone 'UTC')::date
group by operations.operation;

alter table public.global_usage enable row level security;
revoke all on public.global_usage from public, anon, authenticated;
grant select, update on public.global_usage to service_role;

-- Remove the old entry point so outdated servers cannot bypass the shared ceiling.
drop function public.reserve_usage(uuid, text, uuid, bigint, jsonb);

create function public.reserve_usage(p_user_id uuid, p_operation text, p_id uuid,
  p_storage_bytes bigint, p_defaults jsonb, p_global_limits jsonb)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  account public.user_quotas;
  existing public.usage_reservations;
  app_usage public.global_usage;
  day date;
  allowance integer;
  used_count integer;
  global_limit integer;
  global_used integer;
  stored bigint;
  reserved bigint;
begin
  if p_operation is null or p_operation not in ('chat', 'analysis', 'generation') or p_id is null or
      p_storage_bytes is null or p_storage_bytes < 0 or (p_operation <> 'generation' and p_storage_bytes <> 0) then
    raise exception 'invalid reservation';
  end if;
  global_limit := (p_global_limits->>p_operation)::integer;
  if global_limit is null or global_limit < 0 then
    raise exception 'invalid global allowance';
  end if;
  account := public.quota_account(p_user_id, p_defaults);
  select * into existing from public.usage_reservations where id = p_id;
  if found then
    if existing.user_id <> p_user_id or existing.operation <> p_operation then
      raise exception 'reservation belongs to another operation';
    end if;
    return jsonb_build_object('allowed', true, 'id', p_id, 'created', false);
  end if;
  -- All users share one short reservation lock per operation; no provider call holds it.
  select * into strict app_usage from public.global_usage where operation = p_operation for update;
  day := (clock_timestamp() at time zone 'UTC')::date;
  allowance := case p_operation when 'chat' then account.chat_daily
    when 'analysis' then account.analysis_daily else account.generation_daily end;
  select used into used_count from public.daily_usage
    where user_id = p_user_id and usage_date = day and operation = p_operation;
  if coalesce(used_count, 0) >= allowance then
    return jsonb_build_object('allowed', false, 'resource', p_operation,
      'resetAt', (day + 1)::timestamp at time zone 'UTC');
  end if;
  global_used := case when app_usage.usage_date = day then app_usage.used else 0 end;
  if global_used >= global_limit then
    return jsonb_build_object('allowed', false, 'resource', p_operation, 'scope', 'global',
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
  update public.global_usage set usage_date = day, used = global_used + 1 where operation = p_operation;
  return jsonb_build_object('allowed', true, 'id', p_id, 'created', true);
end;
$$;

revoke all on function public.reserve_usage(uuid, text, uuid, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_usage(uuid, text, uuid, bigint, jsonb, jsonb) to service_role;
