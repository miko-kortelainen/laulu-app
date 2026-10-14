begin;

-- Paddle changes items now; laulu keeps the paid tier until the period renews.
create function public.retain_subscription_plan_until_renewal()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.status in ('active', 'trialing')
    and new.period_start = old.period_start and old.period_end is not null
    and array_position(array['starter', 'pro', 'ultra'], new.plan)
      < array_position(array['starter', 'pro', 'ultra'], old.plan) then
    if new.scheduled_change is null then
      new.scheduled_change := jsonb_build_object('action', 'downgrade',
        'effectiveAt', old.period_end, 'plan', new.plan);
    end if;
    new.plan := old.plan;
  end if;
  return new;
end;
$$;

revoke all on function public.retain_subscription_plan_until_renewal() from public, anon, authenticated;
grant execute on function public.retain_subscription_plan_until_renewal() to service_role;
create trigger retain_subscription_plan_until_renewal
  before update on public.paddle_subscriptions
  for each row execute function public.retain_subscription_plan_until_renewal();

commit;
