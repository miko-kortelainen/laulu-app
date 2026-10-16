begin;
set local plpgsql.check_asserts = on;
set local timezone = 'Pacific/Auckland';
update public.global_usage set daily_limit = 2147483647;
do $$
declare
  owner_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  song_id uuid := gen_random_uuid();
  pending_id uuid := gen_random_uuid();
  lyric_id uuid := gen_random_uuid();
  today date := (clock_timestamp() at time zone 'UTC')::date;
  month_start date := date_trunc('month', today::timestamp)::date;
  month_end timestamptz := (month_start::timestamp + interval '1 month') at time zone 'UTC';
  usage jsonb;
  result jsonb;
  global_used integer;
begin
  assert not has_function_privilege('anon', 'public.reserve_usage(uuid,text,uuid,bigint,jsonb,jsonb)', 'execute');
  assert not has_function_privilege('authenticated', 'public.reserve_lyrics(uuid,uuid)', 'execute');
  assert (select songs_daily is null and songs_monthly = 10 and lyrics_daily is null and lyrics_monthly = 20
    from public.plan_limits where plan = 'free');
  insert into auth.users(id) values (owner_id), (other_id);
  perform public.quota_account(owner_id, '{}');
  perform public.quota_account(other_id, '{}');
  insert into public.daily_usage(user_id, usage_date, operation, used) values
    (owner_id, month_start - 1, 'generation', 10), (owner_id, month_start - 1, 'lyrics', 20),
    (owner_id, month_start, 'generation', 9), (owner_id, month_start, 'lyrics', 19),
    (other_id, month_start, 'generation', 1);
  usage := public.get_usage(owner_id, '{}');
  assert usage->'generation' = '{"limit":10,"used":9,"remaining":1}'::jsonb;
  assert usage->'lyrics' = '{"limit":20,"used":19,"remaining":1}'::jsonb;
  assert (usage->>'generationResetAt')::timestamptz = month_end, 'monthly reset is UTC even in another time zone';
  assert (usage->>'resetAt')::timestamptz = (today + 1)::timestamp at time zone 'UTC';

  result := public.reserve_usage(owner_id, 'generation', song_id, 100, '{}');
  assert (result->>'allowed')::boolean;
  assert not (public.reserve_usage(owner_id, 'generation', song_id, 100, '{}')->>'created')::boolean;
  result := public.reserve_usage(owner_id, 'generation', gen_random_uuid(), 0, '{}');
  assert not (result->>'allowed')::boolean and (result->>'resetAt')::timestamptz = month_end;
  perform public.reserve_lyrics(owner_id, lyric_id);
  assert not (public.reserve_lyrics(owner_id, lyric_id)->>'created')::boolean;
  result := public.reserve_lyrics(owner_id, gen_random_uuid());
  assert not (result->>'allowed')::boolean and (result->>'resetAt')::timestamptz = month_end;

  perform public.settle_generation(owner_id, song_id, 'failed');
  assert (public.get_usage(owner_id, '{}')->'generation'->>'remaining')::integer = 1, 'failed songs restore monthly allowance';
  perform public.reserve_usage(owner_id, 'generation', pending_id, 100, '{}');
  select used into global_used from public.global_usage where operation = 'generation';
  result := public.reset_user_usage(owner_id, 'generation');
  assert result = '{"limit":10,"used":0,"remaining":10}'::jsonb;
  assert (public.get_usage(owner_id, '{}')->'lyrics'->>'used')::integer = 20, 'reset affects only songs';
  assert (public.get_usage(other_id, '{}')->'generation'->>'used')::integer = 1, 'other accounts are unchanged';
  assert (select used = global_used from public.global_usage where operation = 'generation');
  assert (select storage_bytes = 100 and quota_reset from public.usage_reservations where id = pending_id);
  assert exists (select 1 from public.daily_usage where user_id = owner_id and usage_date = month_start - 1);
  perform public.reserve_usage(owner_id, 'generation', gen_random_uuid(), 0, '{}');
  perform public.settle_generation(owner_id, pending_id, 'failed');
  assert (public.get_usage(owner_id, '{}')->'generation'->>'used')::integer = 1, 'late refunds cannot erase usage after a reset';
  assert (select storage_bytes = 0 from public.usage_reservations where id = pending_id);
  result := public.reset_user_usage(owner_id, 'lyrics');
  assert result = '{"limit":20,"used":0,"remaining":20}'::jsonb;
  assert (select quota_reset from public.usage_reservations where id = lyric_id);

  update public.global_usage set daily_limit = 0 where operation = 'generation';
  result := public.reserve_usage(owner_id, 'generation', gen_random_uuid(), 0, '{}');
  assert result->>'scope' = 'global' and (result->>'resetAt')::timestamptz = (today + 1)::timestamp at time zone 'UTC';
  update public.global_usage set daily_limit = 2147483647 where operation = 'generation';
  update public.user_quotas set generation_daily = 0 where user_id = owner_id;
  assert not (public.reserve_usage(owner_id, 'generation', gen_random_uuid(), 0, '{}')->>'allowed')::boolean,
    'individual zero blocks remain effective';
  update public.user_quotas set generation_daily = null where user_id = owner_id;
  update public.plan_limits set songs_monthly = 1, lyrics_monthly = 0 where plan = 'free';
  assert not (public.reserve_usage(owner_id, 'generation', gen_random_uuid(), 0, '{}')->>'allowed')::boolean;
  assert not (public.reserve_lyrics(owner_id, gen_random_uuid())->>'allowed')::boolean, 'plan edits apply immediately';

  update public.user_quotas set chat_daily = 1, analysis_daily = 1 where user_id = owner_id;
  perform public.reserve_usage(owner_id, 'chat', gen_random_uuid(), 0, '{}');
  result := public.reserve_usage(owner_id, 'chat', gen_random_uuid(), 0, '{}');
  assert not (result->>'allowed')::boolean and (result->>'resetAt')::timestamptz = (today + 1)::timestamp at time zone 'UTC';
  perform public.reserve_usage(owner_id, 'analysis', gen_random_uuid(), 0, '{}');
  result := public.reserve_usage(owner_id, 'analysis', gen_random_uuid(), 0, '{}');
  assert not (result->>'allowed')::boolean and (result->>'resetAt')::timestamptz = (today + 1)::timestamp at time zone 'UTC';
end;
$$;
rollback;
