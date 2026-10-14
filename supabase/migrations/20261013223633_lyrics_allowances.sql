begin;

alter table public.plan_limits
  add column lyrics_daily integer check (lyrics_daily >= 0),
  add column lyrics_monthly integer check (lyrics_monthly >= 0);
update public.plan_limits set lyrics_daily = 1 where plan = 'free';
update public.plan_limits set
  chat_daily = case plan when 'starter' then 40 when 'pro' then 80 else 150 end,
  lyrics_monthly = case plan when 'starter' then 10 when 'pro' then 30 else 60 end
  where plan <> 'free';
alter table public.plan_limits add constraint plan_limits_lyrics_period check (
  (plan = 'free' and lyrics_daily is not null and lyrics_monthly is null)
  or (plan <> 'free' and lyrics_daily is null and lyrics_monthly is not null));

alter table public.daily_usage drop constraint daily_usage_operation_check;
alter table public.daily_usage add constraint daily_usage_operation_check
  check (operation in ('chat', 'analysis', 'generation', 'lyrics'));
alter table public.usage_reservations drop constraint usage_reservations_operation_check;
alter table public.usage_reservations add constraint usage_reservations_operation_check
  check (operation in ('chat', 'analysis', 'generation', 'lyrics'));
create index usage_billing_lyrics on public.usage_reservations(user_id, billing_subscription_id, billing_period_start)
  where operation = 'lyrics' and billing_subscription_id is not null;

-- Lyrics run only inside admitted chats; the shared chat cap already bounds these attempts.
create function public.reserve_lyrics(p_user_id uuid, p_id uuid)
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
  subscription := public.paid_subscription(p_user_id);
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
    select count(*) into used_count from public.usage_reservations where user_id = p_user_id and operation = 'lyrics'
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
revoke all on function public.reserve_lyrics(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_lyrics(uuid, uuid) to service_role;

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
  select * into strict lyric_limits from public.plan_limits where plan = coalesce(subscription.plan, 'free');
  if subscription.id is not null then
    select count(*) into lyrics_used from public.usage_reservations r where r.user_id = p_user_id and r.operation = 'lyrics'
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

commit;
