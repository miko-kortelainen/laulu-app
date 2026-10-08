-- Lower existing beta accounts without re-enabling disabled or restricted accounts.
update public.user_quotas set chat_daily = 20 where chat_daily > 20;

alter table public.usage_reservations add column generation_status text not null default 'reserved'
  check (generation_status in ('reserved', 'completed', 'failed'));

-- Existing metadata proves completion; unknown historical outcomes stay reserved.
update public.usage_reservations r set generation_status = 'completed'
  where operation = 'generation' and exists (select 1 from public.songs s where s.id = r.id);

create function public.settle_generation(p_user_id uuid, p_id uuid, p_status text)
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
    -- Refund the original UTC day, once. Global attempts remain charged.
    delete from public.daily_usage where user_id = p_user_id and usage_date = reservation.usage_date
      and operation = 'generation' and used = 1;
    update public.daily_usage set used = used - 1
      where user_id = p_user_id and usage_date = reservation.usage_date and operation = 'generation';
  end if;
  update public.usage_reservations set generation_status = p_status,
    storage_bytes = case when p_status = 'failed' then 0 else storage_bytes end
    where id = p_id;
end;
$$;

revoke all on function public.settle_generation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.settle_generation(uuid, uuid, text) to service_role;
