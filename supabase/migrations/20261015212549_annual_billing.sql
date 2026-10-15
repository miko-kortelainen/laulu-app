begin;

alter table public.paddle_subscriptions
  add column billing_interval text not null default 'month' check (billing_interval in ('month', 'year'));

create or replace function public.sync_paddle_event(p_entity text, p_data jsonb, p_occurred_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  owner uuid;
  old_owner uuid;
  customer text := p_data->>'customer_id';
  transaction text := p_data->>'transaction_id';
  subscription text := p_data->>'subscription_id';
  updated timestamptz := (p_data->>'updated_at')::timestamptz;
begin
  if p_occurred_at is null or updated is null then raise exception 'missing event timestamps'; end if;
  perform pg_advisory_xact_lock(hashtextextended('laulu-paddle-sync', 0));
  if p_entity = 'customer' then
    insert into public.paddle_customers as c(id, email, name, status, updated_at, occurred_at)
      values (p_data->>'id', p_data->>'email', p_data->>'name', p_data->>'status', updated, p_occurred_at)
      on conflict (id) do update set email = excluded.email, name = excluded.name, status = excluded.status,
        updated_at = excluded.updated_at, occurred_at = excluded.occurred_at
      where c.updated_at is null or (excluded.updated_at, excluded.occurred_at) > (c.updated_at, c.occurred_at);
    return;
  end if;
  if customer is not null then
    insert into public.paddle_customers(id) values (customer) on conflict (id) do nothing;
  end if;
  if p_entity = 'subscription' then
    subscription := p_data->>'id';
    if transaction is not null then
      select user_id into owner from public.paddle_transactions where id = transaction;
    else
      select user_id, id into owner, transaction from public.paddle_transactions
        where subscription_id = subscription and user_id is not null order by id limit 1;
    end if;
    select user_id into old_owner from public.paddle_subscriptions where id = subscription;
    if owner is not null and old_owner is not null and owner <> old_owner then raise exception 'subscription owner conflict'; end if;
    insert into public.paddle_subscriptions as s(id, user_id, customer_id, transaction_id, status, price_id, plan, billing_interval,
      period_start, period_end, scheduled_change, updated_at, occurred_at)
      values (subscription, owner, customer, transaction, p_data->>'status', p_data->>'price_id', p_data->>'plan', coalesce(p_data->>'billing_interval', 'month'),
        (p_data->>'period_start')::timestamptz, (p_data->>'period_end')::timestamptz,
        nullif(p_data->'scheduled_change', 'null'::jsonb), updated, p_occurred_at)
      on conflict (id) do update set customer_id = excluded.customer_id, status = excluded.status,
        price_id = excluded.price_id, plan = excluded.plan, billing_interval = excluded.billing_interval,
        period_start = excluded.period_start, period_end = excluded.period_end, scheduled_change = excluded.scheduled_change,
        updated_at = excluded.updated_at, occurred_at = excluded.occurred_at
      where (excluded.updated_at, excluded.occurred_at) > (s.updated_at, s.occurred_at);
    -- An older created delivery may establish ownership, but cannot overwrite newer state.
    update public.paddle_subscriptions set user_id = coalesce(user_id, owner), transaction_id = coalesce(transaction_id, transaction)
      where id = subscription;
    update public.paddle_transactions set user_id = coalesce(owner, old_owner)
      where subscription_id = subscription and user_id is null;
    return;
  end if;
  if p_entity = 'transaction' then
    transaction := p_data->>'id';
    select user_id into owner from public.paddle_transactions where id = transaction;
    select user_id into old_owner from public.paddle_subscriptions where id = subscription;
    if owner is not null and old_owner is not null and owner <> old_owner then raise exception 'transaction owner conflict'; end if;
    owner := coalesce(owner, old_owner);
    insert into public.paddle_transactions as t(id, user_id, customer_id, subscription_id, status, currency_code, total, updated_at, occurred_at)
      values (transaction, owner, customer, subscription, p_data->>'status', p_data->>'currency_code', p_data->>'total', updated, p_occurred_at)
      on conflict (id) do update set customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
        status = excluded.status, currency_code = excluded.currency_code, total = excluded.total,
        updated_at = excluded.updated_at, occurred_at = excluded.occurred_at
      where t.updated_at is null or (excluded.updated_at, excluded.occurred_at) > (t.updated_at, t.occurred_at);
    update public.paddle_transactions set user_id = coalesce(user_id, owner) where id = transaction;
    update public.paddle_subscriptions set user_id = coalesce(user_id, owner), transaction_id = coalesce(transaction_id, transaction)
      where id = subscription;
    return;
  end if;
  raise exception 'unsupported billing entity';
end;
$$;

create or replace function public.get_billing(p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  subscription public.paddle_subscriptions;
  paid boolean;
begin
  subscription := public.paid_subscription(p_user_id);
  paid := subscription.id is not null;
  if not paid then
    select * into subscription from public.paddle_subscriptions where user_id = p_user_id
      order by (status <> 'canceled') desc, updated_at desc, id limit 1;
  end if;
  return jsonb_build_object('plan', subscription.plan, 'status', subscription.status, 'paidAccess', paid,
    'periodEnd', subscription.period_end, 'billingInterval', subscription.billing_interval, 'scheduledChange', subscription.scheduled_change, 'transactionId', subscription.transaction_id);
end;
$$;

-- Billing dates stay in the mirror; quota reservations use a monthly window in UTC.
create function public.monthly_allowance_subscription(subscription public.paddle_subscriptions, at_time timestamptz)
returns public.paddle_subscriptions
language plpgsql immutable security invoker set search_path = '' as $$
declare
  month_index integer;
  anchor timestamp;
begin
  if subscription.id is null or subscription.billing_interval <> 'year' then return subscription; end if;
  anchor := subscription.period_start at time zone 'UTC';
  select n into month_index from generate_series(0, 11) n
    where n = 0 or (anchor + make_interval(months => n)) at time zone 'UTC'
      <= least(at_time, subscription.period_end - interval '1 microsecond')
    order by n desc limit 1;
  subscription.period_start := (anchor + make_interval(months => month_index)) at time zone 'UTC';
  subscription.period_end := least(subscription.period_end,
    (anchor + make_interval(months => month_index + 1)) at time zone 'UTC');
  return subscription;
end;
$$;
revoke all on function public.monthly_allowance_subscription(public.paddle_subscriptions, timestamptz) from public, anon, authenticated;
grant execute on function public.monthly_allowance_subscription(public.paddle_subscriptions, timestamptz) to service_role;

create or replace function public.reserve_usage(p_user_id uuid, p_operation text, p_id uuid,
  p_storage_bytes bigint, p_defaults jsonb, p_global_limits jsonb)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  account public.user_quotas;
  existing public.usage_reservations;
  subscription public.paddle_subscriptions;
  reset_at timestamptz;
  app_usage public.global_usage;
  day date;
  allowance integer;
  used_count integer;
  global_limit integer;
  global_used integer;
  stored bigint;
  reserved bigint;
begin
  if p_operation is null or p_operation not in ('chat', 'analysis', 'generation') or p_id is null or
      p_storage_bytes is null or p_storage_bytes < 0 or (p_operation <> 'generation' and p_storage_bytes <> 0) then
    raise exception 'invalid reservation';
  end if;
  global_limit := (p_global_limits->>p_operation)::integer;
  if global_limit is null or global_limit < 0 then
    raise exception 'invalid global allowance';
  end if;
  subscription := public.monthly_allowance_subscription(public.paid_subscription(p_user_id), clock_timestamp());
  account := public.quota_account(p_user_id, p_defaults, coalesce(subscription.plan, 'free'));
  select * into existing from public.usage_reservations where id = p_id;
  if found then
    if existing.user_id <> p_user_id or existing.operation <> p_operation then
      raise exception 'reservation belongs to another operation';
    end if;
    return jsonb_build_object('allowed', true, 'id', p_id, 'created', false);
  end if;
  -- All users share one short reservation lock per operation; no provider call holds it.
  select * into strict app_usage from public.global_usage where operation = p_operation for update;
  day := (clock_timestamp() at time zone 'UTC')::date;
  allowance := case p_operation when 'chat' then account.chat_daily
    when 'analysis' then account.analysis_daily else account.generation_daily end;
  reset_at := (day + 1)::timestamp at time zone 'UTC';
  if p_operation <> 'generation' then subscription := null; end if;
  if subscription.id is not null then
    reset_at := subscription.period_end;
    select count(*) into used_count from public.usage_reservations
      where user_id = p_user_id and operation = 'generation' and generation_status <> 'failed' and not quota_reset
        and billing_subscription_id = subscription.id and billing_period_start = subscription.period_start;
  else
    select used into used_count from public.daily_usage
      where user_id = p_user_id and usage_date = day and operation = p_operation;
  end if;
  if coalesce(used_count, 0) >= allowance then
    return jsonb_build_object('allowed', false, 'resource', p_operation,
      'resetAt', reset_at);
  end if;
  global_used := case when app_usage.usage_date = day then app_usage.used else 0 end;
  if global_used >= global_limit then
    return jsonb_build_object('allowed', false, 'resource', p_operation, 'scope', 'global',
      'resetAt', (day + 1)::timestamp at time zone 'UTC');
  end if;
  if p_storage_bytes > 0 then
    select coalesce(sum(size_bytes), 0) into stored from public.songs where owner_id = p_user_id;
    select coalesce(sum(storage_bytes), 0) into reserved from public.usage_reservations
      where user_id = p_user_id and storage_bytes > 0;
    if stored + reserved > account.storage_bytes - p_storage_bytes then
      return jsonb_build_object('allowed', false, 'resource', 'storage');
    end if;
  end if;
  insert into public.usage_reservations(id, user_id, usage_date, operation, storage_bytes, billing_subscription_id, billing_period_start)
    values (p_id, p_user_id, day, p_operation, p_storage_bytes, subscription.id, subscription.period_start);
  if subscription.id is null then
    insert into public.daily_usage values (p_user_id, day, p_operation, 1)
      on conflict (user_id, usage_date, operation) do update set used = public.daily_usage.used + 1;
  end if;
  update public.global_usage set usage_date = day, used = global_used + 1 where operation = p_operation;
  return jsonb_build_object('allowed', true, 'id', p_id, 'created', true);
end;
$$;

create or replace function public.reserve_lyrics(p_user_id uuid, p_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  subscription public.paddle_subscriptions;
  limits public.plan_limits;
  existing public.usage_reservations;
  day date;
  reset_at timestamptz;
  allowance integer;
  used_count integer;
begin
  if p_id is null then raise exception 'invalid lyrics reservation'; end if;
  subscription := public.monthly_allowance_subscription(public.paid_subscription(p_user_id), clock_timestamp());
  perform public.quota_account(p_user_id, '{}', coalesce(subscription.plan, 'free'));
  select * into existing from public.usage_reservations where id = p_id;
  if found then
    if existing.user_id <> p_user_id or existing.operation <> 'lyrics' then
      raise exception 'reservation belongs to another operation';
    end if;
    return jsonb_build_object('allowed', true, 'id', p_id, 'created', false);
  end if;
  select * into strict limits from public.plan_limits where plan = coalesce(subscription.plan, 'free');
  day := (clock_timestamp() at time zone 'UTC')::date;
  allowance := coalesce(limits.lyrics_monthly, limits.lyrics_daily);
  reset_at := coalesce(subscription.period_end, (day + 1)::timestamp at time zone 'UTC');
  if subscription.id is not null then
    select count(*) into used_count from public.usage_reservations where user_id = p_user_id and operation = 'lyrics' and not quota_reset
      and billing_subscription_id = subscription.id and billing_period_start = subscription.period_start;
  else
    select used into used_count from public.daily_usage where user_id = p_user_id and usage_date = day and operation = 'lyrics';
  end if;
  if coalesce(used_count, 0) >= allowance then
    return jsonb_build_object('allowed', false, 'resource', 'lyrics', 'resetAt', reset_at);
  end if;
  insert into public.usage_reservations(id, user_id, usage_date, operation, billing_subscription_id, billing_period_start)
    values (p_id, p_user_id, day, 'lyrics', subscription.id, subscription.period_start);
  if subscription.id is null then
    insert into public.daily_usage values (p_user_id, day, 'lyrics', 1)
      on conflict (user_id, usage_date, operation) do update set used = public.daily_usage.used + 1;
  end if;
  return jsonb_build_object('allowed', true, 'id', p_id, 'created', true);
end;
$$;

create or replace function public.get_usage(p_user_id uuid, p_defaults jsonb)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  account public.user_quotas;
  subscription public.paddle_subscriptions;
  generation_reset timestamptz;
  day date;
  counts jsonb;
  stored bigint;
  reserved bigint;
  result jsonb;
  operation text;
  lyric_limits public.plan_limits;
  lyrics_used integer;
  allowance integer;
  used_count integer;
begin
  subscription := public.monthly_allowance_subscription(public.paid_subscription(p_user_id), clock_timestamp());
  account := public.quota_account(p_user_id, p_defaults, coalesce(subscription.plan, 'free'));
  day := (clock_timestamp() at time zone 'UTC')::date;
  select jsonb_object_agg(d.operation, d.used) into counts from public.daily_usage d
    where d.user_id = p_user_id and d.usage_date = day;
  generation_reset := coalesce(subscription.period_end, (day + 1)::timestamp at time zone 'UTC');
  result := jsonb_build_object('resetAt', (day + 1)::timestamp at time zone 'UTC',
    'generationResetAt', generation_reset, 'plan', coalesce(subscription.plan, 'free'));
  foreach operation in array array['chat', 'analysis', 'generation'] loop
    allowance := case operation when 'chat' then account.chat_daily
      when 'analysis' then account.analysis_daily else account.generation_daily end;
    used_count := coalesce((counts->>operation)::integer, 0);
    if operation = 'generation' and subscription.id is not null then
      select count(*) into used_count from public.usage_reservations r
        where r.user_id = p_user_id and r.operation = 'generation' and r.generation_status <> 'failed' and not r.quota_reset
          and r.billing_subscription_id = subscription.id and r.billing_period_start = subscription.period_start;
    end if;
    result := result || jsonb_build_object(operation, jsonb_build_object(
      'limit', allowance, 'used', used_count, 'remaining', greatest(0, allowance - used_count)));
  end loop;
  select coalesce(sum(size_bytes), 0) into stored from public.songs where owner_id = p_user_id;
  select coalesce(sum(storage_bytes), 0) into reserved from public.usage_reservations
    where user_id = p_user_id and storage_bytes > 0;
  select * into strict lyric_limits from public.plan_limits where plan = coalesce(subscription.plan, 'free');
  if subscription.id is not null then
    select count(*) into lyrics_used from public.usage_reservations r where r.user_id = p_user_id and r.operation = 'lyrics' and not r.quota_reset
      and r.billing_subscription_id = subscription.id and r.billing_period_start = subscription.period_start;
  else
    lyrics_used := coalesce((counts->>'lyrics')::integer, 0);
  end if;
  allowance := coalesce(lyric_limits.lyrics_monthly, lyric_limits.lyrics_daily);
  result := result || jsonb_build_object('lyrics', jsonb_build_object('limit', allowance,
    'used', lyrics_used, 'remaining', greatest(0, allowance - lyrics_used)));
  return result || jsonb_build_object('storage', jsonb_build_object('limit', account.storage_bytes,
    'used', stored, 'reserved', reserved, 'remaining', greatest(0, account.storage_bytes - stored - reserved)));
end;
$$;

create or replace function public.reset_user_usage(p_user_id uuid, p_operation text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  subscription public.paddle_subscriptions;
  day date;
begin
  if p_user_id is null or p_operation is null or p_operation not in ('chat', 'analysis', 'generation', 'lyrics') then
    raise exception 'invalid usage reset';
  end if;
  subscription := public.monthly_allowance_subscription(public.paid_subscription(p_user_id), clock_timestamp());
  -- Use the admission lock so a concurrent reservation is either reset or charged afterward.
  perform public.quota_account(p_user_id, '{}', coalesce(subscription.plan, 'free'));
  day := (clock_timestamp() at time zone 'UTC')::date;
  if p_operation not in ('generation', 'lyrics') then subscription := null; end if;
  if subscription.id is not null then
    update public.usage_reservations set quota_reset = true
      where user_id = p_user_id and operation = p_operation and not quota_reset
        and billing_subscription_id = subscription.id and billing_period_start = subscription.period_start;
  else
    update public.usage_reservations set quota_reset = true
      where user_id = p_user_id and operation = p_operation and not quota_reset
        and billing_subscription_id is null and usage_date = day;
    delete from public.daily_usage where user_id = p_user_id and operation = p_operation and usage_date = day;
  end if;
  return public.get_usage(p_user_id, '{}')->p_operation;
end;
$$;
commit;
