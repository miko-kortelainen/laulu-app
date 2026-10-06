create table public.songs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  object_key text not null unique,
  prompt text not null check (char_length(prompt) between 1 and 10000),
  model text not null check (model in ('lyria-3.5', 'lyria-3-clip-preview')),
  lyrics text not null default '',
  size_bytes bigint not null check (size_bytes > 0),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  constraint songs_owned_key check (object_key = 'users/' || owner_id::text || '/' || id::text || '.mp3')
);

create index songs_owner_created_at on public.songs (owner_id, created_at desc);

alter table public.songs enable row level security;
revoke all on public.songs from public, anon, authenticated;
grant select on public.songs to authenticated;
grant select, insert, update, delete on public.songs to service_role;

create policy "owners read ready songs" on public.songs for select to authenticated
  using ((select auth.uid()) = owner_id and status = 'ready');
