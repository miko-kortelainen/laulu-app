begin;
set local plpgsql.check_asserts = on;
update public.global_usage set daily_limit = 100;
do $$
declare
  owner_id uuid := gen_random_uuid();
  suffix text := left(replace(gen_random_uuid()::text, '-', ''), 26);
  started timestamptz := clock_timestamp() - interval '2 months 1 day';
  renewal timestamptz := started + interval '1 year';
  subscription public.paddle_subscriptions;
  allowance_period public.paddle_subscriptions;
  usage jsonb;
  result jsonb;
  song_id uuid := gen_random_uuid();
  lyric_id uuid := gen_random_uuid();
begin
  assert not has_function_privilege('anon', 'public.monthly_allowance_subscription(public.paddle_subscriptions,timestamptz)', 'execute');
  assert not has_function_privilege('authenticated', 'public.monthly_allowance_subscription(public.paddle_subscriptions,timestamptz)', 'execute');
  insert into auth.users(id) values (owner_id);
  perform set_config('role', 'service_role', true);
  perform public.register_paddle_checkout('txn_' || suffix, owner_id);
  perform public.sync_paddle_event('subscription', jsonb_build_object(
    'id', 'sub_' || suffix, 'customer_id', 'ctm_' || suffix, 'transaction_id', 'txn_' || suffix,
    'status', 'active', 'plan', 'starter', 'billing_interval', 'year',
    'period_start', started, 'period_end', renewal, 'updated_at', clock_timestamp()), clock_timestamp());
  subscription := public.paid_subscription(owner_id);
  assert subscription.billing_interval = 'year';
  assert (public.get_billing(owner_id)->>'billingInterval') = 'year';
  assert (public.get_billing(owner_id)->>'periodEnd')::timestamptz = renewal, 'payment date stays annual';

  allowance_period := public.monthly_allowance_subscription(subscription, clock_timestamp());
  assert allowance_period.period_start > started and allowance_period.period_end < renewal;
  perform public.quota_account(owner_id, '{}');
  insert into public.usage_reservations(id, user_id, usage_date, operation, billing_subscription_id, billing_period_start)
    values (gen_random_uuid(), owner_id, started::date, 'generation', subscription.id, started),
      (gen_random_uuid(), owner_id, started::date, 'lyrics', subscription.id, started);
  update public.plan_limits set songs_monthly = 1, lyrics_monthly = 1 where plan = 'starter';
  update public.global_usage set usage_date = (clock_timestamp() at time zone 'UTC')::date, used = 0;
  usage := public.get_usage(owner_id, '{}');
  assert (usage->'generation'->>'limit')::integer = 1 and (usage->'generation'->>'used')::integer = 0;
  assert (usage->'lyrics'->>'limit')::integer = 1 and (usage->'lyrics'->>'used')::integer = 0;
  assert (usage->>'generationResetAt')::timestamptz = allowance_period.period_end;
  result := public.reserve_usage(owner_id, 'generation', song_id, 100, '{}');
  assert (result->>'allowed')::boolean;
  assert (select billing_period_start = allowance_period.period_start from public.usage_reservations where id = song_id);
  perform public.reserve_lyrics(owner_id, lyric_id);
  result := public.reserve_usage(owner_id, 'generation', gen_random_uuid(), 0, '{}');
  assert not (result->>'allowed')::boolean, 'annual payment does not grant twelve months upfront';
  assert (result->>'resetAt')::timestamptz = allowance_period.period_end;
  result := public.reserve_lyrics(owner_id, gen_random_uuid());
  assert not (result->>'allowed')::boolean;
  assert (result->>'resetAt')::timestamptz = allowance_period.period_end;
  perform public.reset_user_usage(owner_id, 'generation');
  perform public.reset_user_usage(owner_id, 'lyrics');
  assert (select quota_reset from public.usage_reservations where id = song_id);
  assert not (select quota_reset from public.usage_reservations where user_id = owner_id and billing_period_start = started limit 1);
  assert (public.get_usage(owner_id, '{}')->'generation'->>'used')::integer = 0;
  assert (public.get_usage(owner_id, '{}')->'lyrics'->>'used')::integer = 0;
  perform public.reserve_usage(owner_id, 'generation', gen_random_uuid(), 0, '{}');
  perform public.settle_generation(owner_id, song_id, 'failed');
  assert (public.get_usage(owner_id, '{}')->'generation'->>'used')::integer = 1, 'late failure does not erase new usage';

  -- Clamp short months to their last day, then return to the original anniversary.
  subscription.period_start := '2028-01-31T12:00:00Z';
  subscription.period_end := '2029-01-31T12:00:00Z';
  allowance_period := public.monthly_allowance_subscription(subscription, '2028-02-29T11:59:59Z');
  assert allowance_period.period_start = '2028-01-31T12:00:00Z' and allowance_period.period_end = '2028-02-29T12:00:00Z';
  allowance_period := public.monthly_allowance_subscription(subscription, '2028-02-29T12:00:00Z');
  assert allowance_period.period_start = '2028-02-29T12:00:00Z' and allowance_period.period_end = '2028-03-31T12:00:00Z';
  allowance_period := public.monthly_allowance_subscription(subscription, '2028-04-30T12:00:00Z');
  assert allowance_period.period_start = '2028-04-30T12:00:00Z' and allowance_period.period_end = '2028-05-31T12:00:00Z';
  allowance_period := public.monthly_allowance_subscription(subscription, '2030-01-01T12:00:00Z');
  assert allowance_period.period_end = subscription.period_end and allowance_period.period_start = '2028-12-31T12:00:00Z', 'missing renewal does not grant new months indefinitely';
  subscription.billing_interval := 'month';
  allowance_period := public.monthly_allowance_subscription(subscription, '2028-06-01T12:00:00Z');
  assert allowance_period.period_start = subscription.period_start and allowance_period.period_end = subscription.period_end, 'monthly subscriptions keep their existing allowance_period';
end;
$$;
rollback;
