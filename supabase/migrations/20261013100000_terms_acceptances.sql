create table public.terms_acceptances (
  user_id uuid not null references auth.users(id) on delete cascade,
  version text not null check (char_length(version) between 1 and 64),
  accepted_at timestamptz not null default now(),
  primary key (user_id, version)
);

alter table public.terms_acceptances enable row level security;
revoke all on public.terms_acceptances from public, anon, authenticated;
grant select, insert on public.terms_acceptances to authenticated;
grant select, insert, update, delete on public.terms_acceptances to service_role;

create policy "users read own terms acceptance" on public.terms_acceptances for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "users record own terms acceptance" on public.terms_acceptances for insert to authenticated
  with check ((select auth.uid()) = user_id);
