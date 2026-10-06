begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(10);

insert into auth.users (id) values
  ('10000000-0000-4000-8000-000000000091'),
  ('10000000-0000-4000-8000-000000000092');
insert into public.songs (id, owner_id, object_key, prompt, model, size_bytes, status) values
  ('20000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091',
   'users/10000000-0000-4000-8000-000000000091/20000000-0000-4000-8000-000000000091.mp3', 'folk', 'lyria-3.5', 100, 'ready'),
  ('20000000-0000-4000-8000-000000000092', '10000000-0000-4000-8000-000000000092',
   'users/10000000-0000-4000-8000-000000000092/20000000-0000-4000-8000-000000000092.mp3', 'folk', 'lyria-3.5', 100, 'ready'),
  ('20000000-0000-4000-8000-000000000093', '10000000-0000-4000-8000-000000000091',
   'users/10000000-0000-4000-8000-000000000091/20000000-0000-4000-8000-000000000093.mp3', 'folk', 'lyria-3.5', 100, 'pending');

select ok((select relrowsecurity from pg_class where oid = 'public.songs'::regclass), 'RLS is enabled');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000091","role":"authenticated"}', true);
set local role authenticated;
select results_eq('select id::text from public.songs',
  array['20000000-0000-4000-8000-000000000091'], 'owner sees only their ready song');
select throws_ok('insert into public.songs default values', '42501', 'permission denied for table songs', 'client cannot insert');
select throws_ok('update public.songs set owner_id = gen_random_uuid()', '42501', 'permission denied for table songs', 'client cannot reassign ownership');
select throws_ok('delete from public.songs', '42501', 'permission denied for table songs', 'client cannot delete');
reset role;

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000092","role":"authenticated"}', true);
set local role authenticated;
select results_eq('select id::text from public.songs',
  array['20000000-0000-4000-8000-000000000092'], 'second owner sees only their ready song');
reset role;

set local role anon;
select throws_ok('select * from public.songs', '42501', 'permission denied for table songs', 'anonymous client cannot read');
select throws_ok('insert into public.songs default values', '42501', 'permission denied for table songs', 'anonymous client cannot insert');
select throws_ok('update public.songs set status = ''ready''', '42501', 'permission denied for table songs', 'anonymous client cannot update');
select throws_ok('delete from public.songs', '42501', 'permission denied for table songs', 'anonymous client cannot delete');
reset role;
select * from finish();
rollback;
