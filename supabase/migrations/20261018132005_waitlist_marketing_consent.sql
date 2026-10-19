alter table public.waitlist
  add column marketing_consent boolean not null default false,
  add column marketing_consented_at timestamptz,
  add column marketing_consent_version text,
  add column privacy_notice_version text,
  add constraint waitlist_marketing_consent_evidence check (
    not marketing_consent
    or (marketing_consented_at is not null and marketing_consent_version is not null)
  );

grant update on table public.waitlist to service_role;
