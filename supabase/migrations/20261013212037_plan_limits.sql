begin;

create table public.plan_limits (
  plan text primary key check (plan in ('free', 'starter', 'pro', 'ultra')),
  chat_daily integer not null check (chat_daily >= 0),
  analysis_daily integer not null check (analysis_daily >= 0),
  songs_daily integer check (songs_daily >= 0),
  songs_monthly integer check (songs_monthly >= 0),
  storage_bytes bigint not null check (storage_bytes between 0 and 9007199254740991),
  check ((plan = 'free' and songs_daily is not null and songs_monthly is null)
    or (plan <> 'free' and songs_daily is null and songs_monthly is not null))
);
insert into public.plan_limits values
  ('free', 20, 10, 5, null, 536870912),
  ('starter', 50, 20, null, 30, 2147483648),
  ('pro', 150, 50, null, 80, 5368709120),
  ('ultra', 300, 100, null, 180, 10737418240);
alter table public.plan_limits enable row level security;
revoke all on public.plan_limits from public, anon, authenticated, service_role;
grant select, update on public.plan_limits to service_role;

-- Null follows the plan; retain non-default individual overrides and zero blocks.
alter table public.user_quotas
  alter column chat_daily drop not null,
  alter column analysis_daily drop not null,
  alter column generation_daily drop not null,
  alter column storage_bytes drop not null;
update public.user_quotas set
  chat_daily = nullif(chat_daily, 20), analysis_daily = nullif(analysis_daily, 10),
  generation_daily = nullif(generation_daily, 5), storage_bytes = nullif(storage_bytes, 536870912);

alter table public.paddle_subscriptions drop column song_limit;
alter table public.paddle_subscriptions
  add constraint paddle_subscriptions_paid_plan check (plan is null or plan in ('starter', 'pro', 'ultra')),
  add constraint paddle_subscriptions_plan_fkey foreign key (plan) references public.plan_limits(plan);

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
    insert into public.paddle_subscriptions as s(id, user_id, customer_id, transaction_id, status, price_id, plan,
      period_start, period_end, scheduled_change, updated_at, occurred_at)
      values (subscription, owner, customer, transaction, p_data->>'status', p_data->>'price_id', p_data->>'plan',
        (p_data->>'period_start')::timestamptz, (p_data->>'period_end')::timestamptz,
        nullif(p_data->'scheduled_change', 'null'::jsonb), updated, p_occurred_at)
      on conflict (id) do update set customer_id = excluded.customer_id, status = excluded.status,
        price_id = excluded.price_id, plan = excluded.plan,
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

create or replace function public.paid_subscription(p_user_id uuid)
returns public.paddle_subscriptions language sql stable security invoker set search_path = '' as $$
  select s.* from public.paddle_subscriptions s
    join public.plan_limits p on p.plan = s.plan where s.user_id = p_user_id
    and s.status in ('active', 'trialing') and s.plan is not null
    and s.period_start is not null and s.period_end is not null
  order by p.songs_monthly desc, s.id limit 1;
$$;

-- Keep RPC signatures compatible; p_defaults no longer determines allowances.
create function public.quota_account(p_user_id uuid, p_defaults jsonb, p_plan text)
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
    else coalesce(account.generation_daily, limits.songs_daily) end;
  account.storage_bytes := coalesce(account.storage_bytes, limits.storage_bytes);
  return account;
end;
$$;

revoke all on function public.quota_account(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.quota_account(uuid, jsonb, text) to service_role;

create or replace function public.quota_account(p_user_id uuid, p_defaults jsonb)
returns public.user_quotas
language plpgsql security invoker set search_path = '' as $$
declare
  subscription public.paddle_subscriptions;
begin
  subscription := public.paid_subscription(p_user_id);
  return public.quota_account(p_user_id, p_defaults, coalesce(subscription.plan, 'free'));
end;
$$;

create function public.get_plan_limits()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_agg(to_jsonb(p) order by case p.plan when 'free' then 0 when 'starter' then 1 when 'pro' then 2 else 3 end)
    from public.plan_limits p;
$$;
revoke all on function public.get_plan_limits() from public, anon, authenticated;
grant execute on function public.get_plan_limits() to service_role;

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
  subscription := public.paid_subscription(p_user_id);
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
      where user_id = p_user_id and operation = 'generation' and generation_status <> 'failed'
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
  allowance integer;
  used_count integer;
begin
  subscription := public.paid_subscription(p_user_id);
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
        where r.user_id = p_user_id and r.operation = 'generation' and r.generation_status <> 'failed'
          and r.billing_subscription_id = subscription.id and r.billing_period_start = subscription.period_start;
    end if;
    result := result || jsonb_build_object(operation, jsonb_build_object(
      'limit', allowance, 'used', used_count, 'remaining', greatest(0, allowance - used_count)));
  end loop;
  select coalesce(sum(size_bytes), 0) into stored from public.songs where owner_id = p_user_id;
  select coalesce(sum(storage_bytes), 0) into reserved from public.usage_reservations
    where user_id = p_user_id and storage_bytes > 0;
  return result || jsonb_build_object('storage', jsonb_build_object('limit', account.storage_bytes,
    'used', stored, 'reserved', reserved, 'remaining', greatest(0, account.storage_bytes - stored - reserved)));
end;
$$;

commit;
