create table public.operations (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('music', 'chat')),
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed', 'unknown')),
  status text not null default '',
  result jsonb,
  acknowledged boolean not null default false,
  created_at timestamptz not null default now()
);

create index operations_recovery on public.operations(owner_id, created_at) where not acknowledged;
create index operations_unfinished on public.operations(created_at) where state in ('queued', 'running', 'unknown');

alter table public.operations enable row level security;
revoke all on public.operations from public, anon, authenticated;
grant select, insert, update, delete on public.operations to service_role;

-- Keep uncertain personal and global usage charged. Only release abandoned disk capacity.
create function public.cleanup_operations()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.usage_reservations set storage_bytes = 0
    where id in (select r.id from public.usage_reservations r
      where r.created_at < now() - interval '7 days' and r.storage_bytes > 0
      and not exists (select 1 from public.operations o where o.id = r.id and o.state in ('queued', 'running'))
      and not exists (select 1 from public.songs s where s.id = r.id)
      order by r.created_at limit 100);
  delete from public.usage_reservations where id in (
    select r.id from public.usage_reservations r where r.created_at < now() - interval '30 days'
      and r.storage_bytes = 0 and r.usage_date < (now() at time zone 'UTC')::date
      and not exists (select 1 from public.operations o where o.id = r.id)
      order by r.created_at limit 100);
  delete from public.operations where id in (select id from public.operations
    where created_at < now() - interval '7 days' and state not in ('queued', 'running')
    order by created_at limit 100);
end;
$$;
revoke all on function public.cleanup_operations() from public, anon, authenticated;
grant execute on function public.cleanup_operations() to service_role;
