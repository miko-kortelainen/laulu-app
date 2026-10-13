alter table public.songs
  add column title text not null default 'untitled'
  check (char_length(title) between 1 and 200 and char_length(btrim(title)) > 0);

-- Preserve the storage reservation transaction and accept older metadata without a title.
create or replace function public.prepare_song_save(p_song jsonb, p_defaults jsonb)
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
  song.title := coalesce(nullif(btrim(song.title), ''), 'untitled');
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
