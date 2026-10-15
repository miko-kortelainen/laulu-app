begin;

alter table public.plan_limits
  drop constraint plan_limits_check,
  drop constraint plan_limits_lyrics_period;

update public.plan_limits set songs_daily = null, songs_monthly = 10,
  lyrics_daily = null, lyrics_monthly = 20 where plan = 'free';

alter table public.plan_limits
  add constraint plan_limits_songs_period check (songs_daily is null and songs_monthly is not null),
  add constraint plan_limits_lyrics_period check (lyrics_daily is null and lyrics_monthly is not null);

-- Keep daily counters for refunds; free songs and lyrics sum them over the UTC month.
create or replace function public.quota_account(p_user_id uuid, p_defaults jsonb, p_plan text)
returns public.user_quotas
language plpgsql security invoker set search_path = '' as $$
declare
  account public.user_quotas;
  limits public.plan_limits;
begin
  insert into public.user_quotas(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into strict account from public.user_quotas where user_id = p_user_id for update;
  select * into strict limits from public.plan_limits where plan = p_plan;
  account.chat_daily := coalesce(account.chat_daily, limits.chat_daily);
  account.analysis_daily := coalesce(account.analysis_daily, limits.analysis_daily);
  account.generation_daily := case when p_plan <> 'free' then
    case when account.generation_daily = 0 then 0 else limits.songs_monthly end
    else coalesce(account.generation_daily, limits.songs_monthly) end;
  account.storage_bytes := coalesce(account.storage_bytes, limits.storage_bytes);
  return account;
end;
$$;

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
  reset_at := case when p_operation = 'generation' then
    (date_trunc('month', day::timestamp) + interval '1 month') at time zone 'UTC'
    else (day + 1)::timestamp at time zone 'UTC' end;
  if p_operation <> 'generation' then subscription := null; end if;
  if subscription.id is not null then
    reset_at := subscription.period_end;
    select count(*) into used_count from public.usage_reservations
      where user_id = p_user_id and operation = 'generation' and generation_status <> 'failed' and not quota_reset
        and billing_subscription_id = subscription.id and billing_period_start = subscription.period_start;
  elsif p_operation = 'generation' then
    select coalesce(sum(used), 0) into used_count from public.daily_usage
      where user_id = p_user_id and operation = p_operation
        and usage_date >= date_trunc('month', day::timestamp)::date and usage_date <= day;
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
  allowance := limits.lyrics_monthly;
  reset_at := coalesce(subscription.period_end,
    (date_trunc('month', day::timestamp) + interval '1 month') at time zone 'UTC');
  if subscription.id is not null then
    select count(*) into used_count from public.usage_reservations where user_id = p_user_id and operation = 'lyrics' and not quota_reset
      and billing_subscription_id = subscription.id and billing_period_start = subscription.period_start;
  else
    select coalesce(sum(used), 0) into used_count from public.daily_usage
      where user_id = p_user_id and operation = 'lyrics'
        and usage_date >= date_trunc('month', day::timestamp)::date and usage_date <= day;
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
  generation_reset := coalesce(subscription.period_end,
    (date_trunc('month', day::timestamp) + interval '1 month') at time zone 'UTC');
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
    elsif operation = 'generation' then
      select coalesce(sum(d.used), 0) into used_count from public.daily_usage d
        where d.user_id = p_user_id and d.operation = 'generation'
          and d.usage_date >= date_trunc('month', day::timestamp)::date and d.usage_date <= day;
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
    select coalesce(sum(d.used), 0) into lyrics_used from public.daily_usage d
      where d.user_id = p_user_id and d.operation = 'lyrics'
        and d.usage_date >= date_trunc('month', day::timestamp)::date and d.usage_date <= day;
  end if;
  allowance := lyric_limits.lyrics_monthly;
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
  period_start date;
begin
  if p_user_id is null or p_operation is null or p_operation not in ('chat', 'analysis', 'generation', 'lyrics') then
    raise exception 'invalid usage reset';
  end if;
  subscription := public.monthly_allowance_subscription(public.paid_subscription(p_user_id), clock_timestamp());
  -- Use the admission lock so a concurrent reservation is either reset or charged afterward.
  perform public.quota_account(p_user_id, '{}', coalesce(subscription.plan, 'free'));
  day := (clock_timestamp() at time zone 'UTC')::date;
  period_start := case when p_operation in ('generation', 'lyrics')
    then date_trunc('month', day::timestamp)::date else day end;
  if p_operation not in ('generation', 'lyrics') then subscription := null; end if;
  if subscription.id is not null then
    update public.usage_reservations set quota_reset = true
      where user_id = p_user_id and operation = p_operation and not quota_reset
        and billing_subscription_id = subscription.id and billing_period_start = subscription.period_start;
  else
    update public.usage_reservations set quota_reset = true
      where user_id = p_user_id and operation = p_operation and not quota_reset
        and billing_subscription_id is null and usage_date >= period_start and usage_date <= day;
    delete from public.daily_usage where user_id = p_user_id and operation = p_operation
      and usage_date >= period_start and usage_date <= day;
  end if;
  return public.get_usage(p_user_id, '{}')->p_operation;
end;
$$;
commit;
