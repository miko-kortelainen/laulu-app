begin;

-- Billing mirrors are permanent state. They are never part of operation cleanup.
create table public.paddle_customers (
  id text primary key check (id ~ '^ctm_[a-z0-9]{26}$'),
  email text,
  name text,
  status text,
  updated_at timestamptz,
  occurred_at timestamptz
);

create table public.paddle_subscriptions (
  id text primary key check (id ~ '^sub_[a-z0-9]{26}$'),
  user_id uuid references auth.users(id) on delete set null,
  customer_id text not null references public.paddle_customers(id),
  transaction_id text,
  status text not null check (status in ('active', 'trialing', 'paused', 'past_due', 'canceled')),
  price_id text,
  plan text,
  song_limit integer not null default 0,
  period_start timestamptz,
  period_end timestamptz,
  scheduled_change jsonb,
  updated_at timestamptz not null,
  occurred_at timestamptz not null,
  check ((plan is null and song_limit = 0) or (plan is not null and (
    (plan = 'starter' and song_limit = 30) or (plan = 'pro' and song_limit = 80) or (plan = 'ultra' and song_limit = 180)))),
  check (period_start is null or period_end is null or period_end > period_start)
);
create index paddle_subscriptions_user on public.paddle_subscriptions(user_id);
create index paddle_subscriptions_transaction on public.paddle_subscriptions(transaction_id);

create table public.paddle_transactions (
  id text primary key check (id ~ '^txn_[a-z0-9]{26}$'),
  user_id uuid references auth.users(id) on delete set null,
  customer_id text references public.paddle_customers(id),
  subscription_id text,
  status text,
  currency_code text,
  total text,
  updated_at timestamptz,
  occurred_at timestamptz
);
create index paddle_transactions_subscription on public.paddle_transactions(subscription_id);
create index paddle_transactions_user on public.paddle_transactions(user_id);

alter table public.paddle_customers enable row level security;
alter table public.paddle_subscriptions enable row level security;
alter table public.paddle_transactions enable row level security;
revoke all on public.paddle_customers, public.paddle_subscriptions, public.paddle_transactions from public, anon, authenticated, service_role;
grant select, insert, update on public.paddle_customers, public.paddle_subscriptions, public.paddle_transactions to service_role;

alter table public.usage_reservations
  add column billing_subscription_id text references public.paddle_subscriptions(id),
  add column billing_period_start timestamptz,
  add constraint usage_billing_period check ((billing_subscription_id is null) = (billing_period_start is null));
create index usage_billing_generation on public.usage_reservations(user_id, billing_subscription_id, billing_period_start)
  where operation = 'generation' and generation_status <> 'failed';

create function public.register_paddle_checkout(p_transaction_id text, p_user_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  owner uuid;
begin
  -- Serialize only short billing writes, including delivery-before-checkout-record races.
  perform pg_advisory_xact_lock(hashtextextended('laulu-paddle-sync', 0));
  if p_user_id is null then raise exception 'missing checkout owner'; end if;
  select user_id into owner from public.paddle_transactions where id = p_transaction_id;
  if owner is not null and owner <> p_user_id then raise exception 'checkout owner conflict'; end if;
  insert into public.paddle_transactions(id, user_id) values (p_transaction_id, p_user_id)
    on conflict (id) do update set user_id = excluded.user_id;
  if exists (select 1 from public.paddle_subscriptions s where
      (s.transaction_id = p_transaction_id or s.id = (select subscription_id from public.paddle_transactions where id = p_transaction_id))
      and s.user_id is not null and s.user_id <> p_user_id) then
    raise exception 'subscription owner conflict';
  end if;
  update public.paddle_subscriptions set user_id = p_user_id where
    transaction_id = p_transaction_id or id = (select subscription_id from public.paddle_transactions where id = p_transaction_id);
  update public.paddle_transactions t set user_id = p_user_id from public.paddle_subscriptions s
    where t.subscription_id = s.id and s.user_id = p_user_id and t.user_id is null;
end;
$$;

create function public.sync_paddle_event(p_entity text, p_data jsonb, p_occurred_at timestamptz)
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
    insert into public.paddle_subscriptions as s(id, user_id, customer_id, transaction_id, status, price_id, plan, song_limit,
      period_start, period_end, scheduled_change, updated_at, occurred_at)
      values (subscription, owner, customer, transaction, p_data->>'status', p_data->>'price_id', p_data->>'plan',
        (p_data->>'song_limit')::integer, (p_data->>'period_start')::timestamptz, (p_data->>'period_end')::timestamptz,
        nullif(p_data->'scheduled_change', 'null'::jsonb), updated, p_occurred_at)
      on conflict (id) do update set customer_id = excluded.customer_id, status = excluded.status,
        price_id = excluded.price_id, plan = excluded.plan, song_limit = excluded.song_limit,
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

create function public.paid_subscription(p_user_id uuid)
returns public.paddle_subscriptions language sql stable security invoker set search_path = '' as $$
  select s.* from public.paddle_subscriptions s where s.user_id = p_user_id
    and s.status in ('active', 'trialing') and s.song_limit > 0
    and s.period_start is not null and s.period_end is not null
  order by s.song_limit desc, s.id limit 1;
$$;

create function public.get_billing(p_user_id uuid)
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
    'periodEnd', subscription.period_end, 'scheduledChange', subscription.scheduled_change, 'transactionId', subscription.transaction_id);
end;
$$;

revoke all on function public.register_paddle_checkout(text, uuid), public.sync_paddle_event(text, jsonb, timestamptz),
  public.paid_subscription(uuid), public.get_billing(uuid) from public, anon, authenticated;
grant execute on function public.register_paddle_checkout(text, uuid), public.sync_paddle_event(text, jsonb, timestamptz),
  public.paid_subscription(uuid), public.get_billing(uuid) to service_role;

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
  account := public.quota_account(p_user_id, p_defaults);
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
  if p_operation = 'generation' then subscription := public.paid_subscription(p_user_id); end if;
  if subscription.id is not null then
    allowance := case when account.generation_daily = 0 then 0 else subscription.song_limit end;
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
  account := public.quota_account(p_user_id, p_defaults);
  day := (clock_timestamp() at time zone 'UTC')::date;
  select jsonb_object_agg(d.operation, d.used) into counts from public.daily_usage d
    where d.user_id = p_user_id and d.usage_date = day;
  subscription := public.paid_subscription(p_user_id);
  generation_reset := coalesce(subscription.period_end, (day + 1)::timestamp at time zone 'UTC');
  result := jsonb_build_object('resetAt', (day + 1)::timestamp at time zone 'UTC',
    'generationResetAt', generation_reset, 'plan', coalesce(subscription.plan, 'free'));
  foreach operation in array array['chat', 'analysis', 'generation'] loop
    allowance := case operation when 'chat' then account.chat_daily
      when 'analysis' then account.analysis_daily else account.generation_daily end;
    used_count := coalesce((counts->>operation)::integer, 0);
    if operation = 'generation' and subscription.id is not null then
      allowance := case when account.generation_daily = 0 then 0 else subscription.song_limit end;
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


create or replace function public.settle_generation(p_user_id uuid, p_id uuid, p_status text)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  reservation public.usage_reservations;
begin
  if p_status is null or p_status not in ('completed', 'failed') then
    raise exception 'invalid generation status';
  end if;
  -- Use the same account lock as reservation and storage settlement.
  perform 1 from public.user_quotas where user_id = p_user_id for update;
  select * into reservation from public.usage_reservations
    where id = p_id and user_id = p_user_id and operation = 'generation';
  if not found or reservation.generation_status <> 'reserved' then return; end if;
  if p_status = 'failed' then
    if exists (select 1 from public.songs where id = p_id) then
      raise exception 'completed song cannot be refunded';
    end if;
    -- Monthly reservations stop counting when marked failed; refund free usage on its original day.
    if reservation.billing_subscription_id is null then
      delete from public.daily_usage where user_id = p_user_id and usage_date = reservation.usage_date
        and operation = 'generation' and used = 1;
      update public.daily_usage set used = used - 1
        where user_id = p_user_id and usage_date = reservation.usage_date and operation = 'generation';
    end if;
  end if;
  update public.usage_reservations set generation_status = p_status,
    storage_bytes = case when p_status = 'failed' then 0 else storage_bytes end
    where id = p_id;
end;
$$;


create or replace function public.cleanup_operations()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.usage_reservations set storage_bytes = 0
    where id in (select r.id from public.usage_reservations r
      where r.created_at < now() - interval '7 days' and r.storage_bytes > 0
      and not exists (select 1 from public.operations o where o.id = r.id and o.state in ('queued', 'running'))
      and not exists (select 1 from public.songs s where s.id = r.id)
      order by r.created_at limit 100);
  delete from public.usage_reservations where id in (
    select r.id from public.usage_reservations r where r.created_at < now() - interval '30 days'
      and r.billing_subscription_id is null and r.storage_bytes = 0 and r.usage_date < (now() at time zone 'UTC')::date
      and not exists (select 1 from public.operations o where o.id = r.id)
      order by r.created_at limit 100);
  delete from public.operations where id in (select id from public.operations
    where created_at < now() - interval '7 days' and state not in ('queued', 'running')
    order by created_at limit 100);
end;
$$;

commit;
