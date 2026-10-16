begin;
set local plpgsql.check_asserts = on;
set local timezone = 'Pacific/Auckland';
do $$
declare
  owner_id uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid();
  today date := (clock_timestamp() at time zone 'UTC')::date;
  result jsonb;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.global_usage'::regclass);
  assert not has_table_privilege('anon', 'public.global_usage', 'select');
  assert not has_table_privilege('authenticated', 'public.global_usage', 'update');
  assert not has_function_privilege('authenticated', 'public.reserve_usage(uuid,text,uuid,bigint,jsonb,jsonb)', 'execute');
  insert into auth.users(id) values (owner_id);
  perform public.quota_account(owner_id, '{}');
  perform set_config('role', 'service_role', true);
  update public.global_usage set daily_limit = 1, used = 0, usage_date = today where operation = 'chat';

  result := public.reserve_usage(owner_id, 'chat', request_id, 0, '{}');
  assert (result->>'allowed')::boolean;
  result := public.reserve_usage(owner_id, 'chat', gen_random_uuid(), 0, '{}', '{"chat":999999}');
  assert result->>'scope' = 'global', 'legacy server limits cannot bypass the database limit';
  assert (result->>'resetAt')::timestamptz = (today + 1)::timestamp at time zone 'UTC';
  assert (select used = 1 from public.global_usage where operation = 'chat');

  update public.global_usage set daily_limit = 2 where operation = 'chat';
  result := public.reserve_usage(owner_id, 'chat', gen_random_uuid(), 0, '{}', '{"chat":0}');
  assert (result->>'allowed')::boolean, 'raising the database limit applies immediately, even to old servers';
  assert (select used = 2 and usage_date = today from public.global_usage where operation = 'chat');

  update public.global_usage set daily_limit = 0 where operation = 'chat';
  assert (public.reserve_usage(owner_id, 'chat', gen_random_uuid(), 0, '{}')->>'scope') = 'global', 'zero disables new work';
  assert not (public.reserve_usage(owner_id, 'chat', request_id, 0, '{}')->>'created')::boolean, 'existing reservations remain idempotent';
  assert (select used = 2 from public.global_usage where operation = 'chat');

  update public.global_usage set daily_limit = 1, usage_date = today - 1 where operation = 'chat';
  assert (public.reserve_usage(owner_id, 'chat', gen_random_uuid(), 0, '{}')->>'allowed')::boolean;
  assert (select used = 1 and usage_date = today and daily_limit = 1 from public.global_usage where operation = 'chat'), 'UTC rollover preserves the configured limit';

  begin
    update public.global_usage set daily_limit = -1 where operation = 'chat';
    raise exception 'negative limits must be rejected';
  exception when check_violation then null;
  end;
  begin
    update public.global_usage set daily_limit = null where operation = 'chat';
    raise exception 'null limits must be rejected';
  exception when not_null_violation then null;
  end;
end;
$$;
rollback;
