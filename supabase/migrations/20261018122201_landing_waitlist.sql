create table public.waitlist (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint waitlist_email_format check (
    email = lower(btrim(email))
    and char_length(email) <= 254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  )
);

alter table public.waitlist enable row level security;

revoke all on table public.waitlist from public, anon, authenticated;
grant select, insert on table public.waitlist to service_role;
