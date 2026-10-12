begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(11);

insert into auth.users (id) values
  ('10000000-0000-4000-8000-000000000091'),
  ('10000000-0000-4000-8000-000000000092');
insert into public.terms_acceptances (user_id, version) values
  ('10000000-0000-4000-8000-000000000091', '2026-10-12'),
  ('10000000-0000-4000-8000-000000000092', '2026-10-12');

select ok((select relrowsecurity from pg_class where oid = 'public.terms_acceptances'::regclass), 'RLS is enabled');
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000091', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select results_eq('select version from public.terms_acceptances',
  array['2026-10-12'], 'owner sees only their own acceptance');
select lives_ok(
  $$insert into public.terms_acceptances (user_id, version) values ('10000000-0000-4000-8000-000000000091', '2026-11-01')$$,
  'owner can record acceptance of a new version');
select throws_ok(
  $$insert into public.terms_acceptances (user_id, version) values ('10000000-0000-4000-8000-000000000092', '2026-11-01')$$,
  '42501', 'new row violates row-level security policy for table "terms_acceptances"', 'owner cannot record acceptance for another user');
select throws_ok('update public.terms_acceptances set version = ''2000-01-01''',
  '42501', 'permission denied for table terms_acceptances', 'client cannot rewrite acceptance history');
select throws_ok('delete from public.terms_acceptances',
  '42501', 'permission denied for table terms_acceptances', 'client cannot delete acceptance history');
reset role;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000092', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select results_eq('select user_id::text from public.terms_acceptances',
  array['10000000-0000-4000-8000-000000000092'], 'second owner sees only their own acceptance');
reset role;

set local role anon;
select throws_ok('select * from public.terms_acceptances', '42501', 'permission denied for table terms_acceptances', 'anonymous client cannot read');
select throws_ok('insert into public.terms_acceptances default values', '42501', 'permission denied for table terms_acceptances', 'anonymous client cannot insert');
select throws_ok('update public.terms_acceptances set version = ''2000-01-01''', '42501', 'permission denied for table terms_acceptances', 'anonymous client cannot update');
select throws_ok('delete from public.terms_acceptances', '42501', 'permission denied for table terms_acceptances', 'anonymous client cannot delete');
reset role;
select * from finish();
rollback;
