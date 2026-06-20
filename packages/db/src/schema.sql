-- =============================================================================
-- Affiliate Platform — normalized Postgres schema (Section 10).
--
-- This is the production data model. The application's DEFAULT runtime uses the
-- in-memory repository (memory.ts) so the system boots with zero external
-- services; this schema is the target for a Postgres deployment and for the
-- reporting/analytics surface. `postgres.ts` provides a Database-port adapter.
--
-- Conventions: ids are text (UUIDv4 with prefixes, UUIDv7 for clicks). Money is
-- integer cents + a 3-letter currency. Every tenant-scoped table carries
-- merchant_id and should be protected by row-level security in production.
-- =============================================================================

-- ---- Tenancy ----------------------------------------------------------------
CREATE TABLE merchants (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'trial',
  niche           text,
  competitors     text[] NOT NULL DEFAULT '{}',
  billing_status  text NOT NULL DEFAULT 'trialing',
  default_currency text NOT NULL DEFAULT 'USD',
  postback_secret text NOT NULL,
  physical_address text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_users (
  id          text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  UNIQUE (merchant_id, user_id)
);
CREATE INDEX merchant_users_merchant_idx ON merchant_users(merchant_id);

CREATE TABLE audit_logs (
  id           text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  actor_id     text,
  action       text NOT NULL,
  subject_type text NOT NULL,
  subject_id   text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  ts           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_merchant_ts_idx ON audit_logs(merchant_id, ts DESC);

-- ---- Billing and entitlements ----------------------------------------------
CREATE TABLE billing_subscriptions (
  id            text PRIMARY KEY,
  merchant_id   text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  plan          text NOT NULL,
  status        text NOT NULL,
  trial_ends_at timestamptz,
  renews_at     timestamptz
);
CREATE INDEX billing_subscriptions_merchant_idx ON billing_subscriptions(merchant_id);

CREATE TABLE usage_events (
  id          text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  quantity    numeric NOT NULL,
  source_id   text,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_merchant_kind_idx ON usage_events(merchant_id, kind, ts);

CREATE TABLE entitlements (
  id          text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  feature     text NOT NULL,
  limit_value numeric,
  source_plan text NOT NULL,
  UNIQUE (merchant_id, feature)
);

-- ---- Integrations -----------------------------------------------------------
CREATE TABLE merchant_integrations (
  id              text PRIMARY KEY,
  merchant_id     text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  status          text NOT NULL,
  credentials_ref text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}',
  last_sync_at    timestamptz
);
CREATE INDEX merchant_integrations_merchant_idx ON merchant_integrations(merchant_id);

CREATE TABLE mailboxes (
  id              text PRIMARY KEY,
  merchant_id     text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  email           text NOT NULL,
  status          text NOT NULL,
  daily_cap       integer NOT NULL DEFAULT 50,
  warmup_status   text NOT NULL DEFAULT 'not_started',
  credentials_ref text NOT NULL
);

CREATE TABLE sending_domains (
  id            text PRIMARY KEY,
  merchant_id   text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  domain        text NOT NULL,
  spf_status    text NOT NULL DEFAULT 'pending',
  dkim_status   text NOT NULL DEFAULT 'pending',
  dmarc_status  text NOT NULL DEFAULT 'pending',
  warmup_status text NOT NULL DEFAULT 'not_started'
);

CREATE TABLE webhook_deliveries (
  id          text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  target_url  text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  ts          timestamptz NOT NULL DEFAULT now()
);

-- ---- Global identity + relationship graph (substrate) ----------------------
CREATE TABLE affiliates (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  primary_email   text NOT NULL,
  country         text,
  audience_profile jsonb,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affiliates_email_idx ON affiliates(lower(primary_email));

CREATE TABLE payout_accounts (
  id           text PRIMARY KEY,
  affiliate_id text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  rail         text NOT NULL,
  account_ref  text NOT NULL,
  status       text NOT NULL DEFAULT 'unverified',
  currency     text NOT NULL
);

CREATE TABLE tax_documents (
  id           text PRIMARY KEY,
  affiliate_id text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  rail         text,
  form_type    text NOT NULL,
  status       text NOT NULL DEFAULT 'missing',
  collected_at timestamptz
);

CREATE TABLE programs (
  id               text PRIMARY KEY,
  merchant_id      text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  terms_url        text,
  approval_mode    text NOT NULL DEFAULT 'manual',
  default_currency text NOT NULL DEFAULT 'USD'
);
CREATE INDEX programs_merchant_idx ON programs(merchant_id);

-- The per-merchant relationship carries role + the self-referential sponsor
-- pointer — the two decisions that keep the network and MLM as options.
CREATE TABLE affiliate_relationships (
  id                   text PRIMARY KEY,
  affiliate_id         text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  merchant_id          text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  program_id           text NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'pending',
  joined_at            timestamptz NOT NULL DEFAULT now(),
  role                 text NOT NULL DEFAULT 'seller',          -- seller | recruiter | both
  commission_terms     jsonb,
  source               text NOT NULL DEFAULT 'inbound',
  owner_user_id        text,
  tags                 text[] NOT NULL DEFAULT '{}',
  sponsor_affiliate_id text REFERENCES affiliates(id),          -- the recruiter
  prospect_id          text,                                    -- source-yield FK
  UNIQUE (affiliate_id, program_id)
);
CREATE INDEX rel_merchant_idx ON affiliate_relationships(merchant_id);
CREATE INDEX rel_sponsor_idx ON affiliate_relationships(sponsor_affiliate_id);

CREATE TABLE agreements (
  id           text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  program_id   text NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  version      text NOT NULL,
  body_ref     text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agreement_acceptances (
  id              text PRIMARY KEY,
  agreement_id    text NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  affiliate_id    text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  relationship_id text NOT NULL REFERENCES affiliate_relationships(id) ON DELETE CASCADE,
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  ip              text
);

-- ---- Orders, attribution, ledger, payouts (substrate) ----------------------
CREATE TABLE offers (
  id           text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  program_id   text NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  engine       text NOT NULL DEFAULT 'affiliate',  -- routes to commission engine
  name         text NOT NULL,
  payout_type  text NOT NULL,                       -- percentage | flat
  payout_value numeric NOT NULL,
  currency     text NOT NULL DEFAULT 'USD',
  window_days  integer NOT NULL DEFAULT 30,
  rules        jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'active'
);
CREATE INDEX offers_merchant_idx ON offers(merchant_id);

CREATE TABLE commission_tiers (
  id              text PRIMARY KEY,
  offer_id        text NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  min_volume_cents bigint NOT NULL,
  rate            numeric NOT NULL
);

CREATE TABLE bonuses (
  id           text PRIMARY KEY,
  offer_id     text NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  trigger_type text NOT NULL,
  threshold    bigint NOT NULL,
  amount_cents bigint NOT NULL
);

CREATE TABLE override_policy (
  id        text PRIMARY KEY,
  offer_id  text NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  structure text NOT NULL,           -- flat | percentage
  value     numeric NOT NULL,
  trigger   text NOT NULL,           -- first_sale | per_sale
  max_depth integer NOT NULL DEFAULT 1
);

CREATE TABLE affiliate_codes (
  id             text PRIMARY KEY,
  affiliate_id   text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  merchant_id    text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  code           text NOT NULL,
  kind           text NOT NULL,       -- discount | referral
  discount_value numeric,
  usage_cap      integer,
  usage_count    integer NOT NULL DEFAULT 0,
  expires_at     timestamptz,
  UNIQUE (merchant_id, code)
);

CREATE TABLE creatives (
  id         text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  program_id text NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  type       text NOT NULL,
  name       text NOT NULL,
  asset_ref  text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'active'
);

CREATE TABLE customers (
  id                   text PRIMARY KEY,
  merchant_id          text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  external_customer_id text,
  email_hash           text,
  country              text,
  first_seen_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_merchant_idx ON customers(merchant_id);

CREATE TABLE orders (
  id            text PRIMARY KEY,
  merchant_id   text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  customer_id   text REFERENCES customers(id),
  amount_cents  bigint NOT NULL,
  currency      text NOT NULL,
  txn_id        text NOT NULL,
  ts            timestamptz NOT NULL DEFAULT now(),
  line_items    jsonb NOT NULL DEFAULT '[]',
  coupon_codes  text[] NOT NULL DEFAULT '{}',
  is_new_customer boolean NOT NULL DEFAULT false,
  is_rebill     boolean NOT NULL DEFAULT false,
  subtotal_cents bigint NOT NULL DEFAULT 0,
  discount_cents bigint NOT NULL DEFAULT 0,
  tax_cents     bigint NOT NULL DEFAULT 0,
  shipping_cents bigint NOT NULL DEFAULT 0,
  country       text,
  UNIQUE (merchant_id, txn_id)          -- idempotency / dedup (Section 6)
);
CREATE INDEX orders_merchant_ts_idx ON orders(merchant_id, ts DESC);

-- click_id is UUIDv7 (time-sortable); the redirect hot path writes here async.
CREATE TABLE clicks (
  click_id     text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  affiliate_id text NOT NULL REFERENCES affiliates(id),
  offer_id     text NOT NULL REFERENCES offers(id),
  ts           timestamptz NOT NULL DEFAULT now(),
  ip           text,
  ua           text,
  landing_url  text,
  sub1 text, sub2 text, sub3 text, sub4 text, sub5 text
);
CREATE INDEX clicks_merchant_ts_idx ON clicks(merchant_id, ts DESC);
CREATE INDEX clicks_affiliate_idx ON clicks(affiliate_id);

CREATE TABLE conversions (
  id            text PRIMARY KEY,
  merchant_id   text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  click_id      text REFERENCES clicks(click_id),
  order_id      text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  affiliate_id  text NOT NULL REFERENCES affiliates(id),
  code_id       text REFERENCES affiliate_codes(id),
  amount_cents  bigint NOT NULL,
  currency      text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|reversed
  review_status text NOT NULL DEFAULT 'none',
  ts            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversions_merchant_idx ON conversions(merchant_id, ts DESC);
CREATE INDEX conversions_affiliate_idx ON conversions(affiliate_id);

-- Append-only ledger: amounts immutable; balances always derived (Section 4).
CREATE TABLE ledger (
  id                text PRIMARY KEY,
  merchant_id       text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  affiliate_id      text NOT NULL REFERENCES affiliates(id),
  conversion_id     text REFERENCES conversions(id),
  type              text NOT NULL,    -- commission|override|bonus|adjustment|reversal
  amount_cents      bigint NOT NULL,
  currency          text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  available_at      timestamptz,
  ts                timestamptz NOT NULL DEFAULT now(),
  reverses_entry_id text REFERENCES ledger(id),
  metadata          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ledger_affiliate_status_idx ON ledger(affiliate_id, status);
CREATE INDEX ledger_merchant_idx ON ledger(merchant_id);

CREATE TABLE overrides (
  id                      text PRIMARY KEY,
  conversion_id           text NOT NULL REFERENCES conversions(id) ON DELETE CASCADE,
  beneficiary_affiliate_id text NOT NULL REFERENCES affiliates(id),
  level                   integer NOT NULL,
  amount_cents            bigint NOT NULL
);

CREATE TABLE payout_batches (
  id          text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  rail        text NOT NULL,
  currency    text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  approved_by text,
  ts          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payouts (
  id             text PRIMARY KEY,
  batch_id       text REFERENCES payout_batches(id),
  merchant_id    text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  affiliate_id   text NOT NULL REFERENCES affiliates(id),
  amount_cents   bigint NOT NULL,
  currency       text NOT NULL,
  method         text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  failure_reason text,
  ts             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_affiliate_idx ON payouts(affiliate_id);

CREATE TABLE payout_adjustments (
  id           text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  affiliate_id text NOT NULL REFERENCES affiliates(id),
  amount_cents bigint NOT NULL,
  currency     text NOT NULL,
  reason       text NOT NULL,
  created_by   text NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now()
);

-- ---- CRM --------------------------------------------------------------------
CREATE TABLE affiliate_notes (
  id              text PRIMARY KEY,
  relationship_id text NOT NULL REFERENCES affiliate_relationships(id) ON DELETE CASCADE,
  author_id       text NOT NULL,
  body            text NOT NULL,
  ts              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE affiliate_tasks (
  id              text PRIMARY KEY,
  relationship_id text NOT NULL REFERENCES affiliate_relationships(id) ON DELETE CASCADE,
  owner_user_id   text NOT NULL,
  title           text NOT NULL,
  due_at          timestamptz,
  status          text NOT NULL DEFAULT 'open'
);

CREATE TABLE affiliate_messages (
  id              text PRIMARY KEY,
  relationship_id text NOT NULL REFERENCES affiliate_relationships(id) ON DELETE CASCADE,
  direction       text NOT NULL,
  channel         text NOT NULL,
  subject         text,
  body_ref        text NOT NULL,
  ts              timestamptz NOT NULL DEFAULT now()
);

-- ---- Recruitment engine -----------------------------------------------------
CREATE TABLE prospects (
  id                 text PRIMARY KEY,
  merchant_id        text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  source             text NOT NULL,
  identity           text NOT NULL,
  site_url           text,
  channel_url        text,
  email              text,
  state              text NOT NULL DEFAULT 'discovered',
  score              numeric,
  tier               text,
  country            text,
  language           text,
  suppression_status text NOT NULL DEFAULT 'none',
  score_breakdown    jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prospects_merchant_state_idx ON prospects(merchant_id, state);
CREATE INDEX prospects_tier_idx ON prospects(merchant_id, tier);

CREATE TABLE prospect_sources (
  id              text PRIMARY KEY,
  prospect_id     text NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  source_type     text NOT NULL,
  evidence_url    text,
  evidence_summary text,
  captured_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prospect_signals (
  id                 text PRIMARY KEY,
  prospect_id        text NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  relevance          numeric NOT NULL DEFAULT 0,
  reach              bigint NOT NULL DEFAULT 0,
  da                 numeric NOT NULL DEFAULT 0,
  engagement         numeric NOT NULL DEFAULT 0,
  is_affiliate       boolean NOT NULL DEFAULT false,
  promotes_competitor boolean NOT NULL DEFAULT false,
  intent             numeric NOT NULL DEFAULT 0,
  verified_email     boolean NOT NULL DEFAULT false,
  audience_overlap   numeric NOT NULL DEFAULT 0
);

CREATE TABLE outreach_campaigns (
  id                text PRIMARY KEY,
  merchant_id       text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  mailbox_id        text REFERENCES mailboxes(id),
  sending_domain_id text REFERENCES sending_domains(id),
  name              text NOT NULL,
  sequence          jsonb NOT NULL DEFAULT '[]',
  send_window       jsonb NOT NULL DEFAULT '{}',
  daily_cap         integer NOT NULL DEFAULT 50,
  status            text NOT NULL DEFAULT 'draft'
);

CREATE TABLE outreach_messages (
  id          text PRIMARY KEY,
  prospect_id text NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  step        integer NOT NULL,
  variant     text,
  subject     text NOT NULL,
  body        text NOT NULL,
  sent_at     timestamptz,
  status      text NOT NULL DEFAULT 'queued'
);

CREATE TABLE replies (
  id             text PRIMARY KEY,
  prospect_id    text NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  raw            text NOT NULL,
  classification text NOT NULL,
  handled_by     text,
  ts             timestamptz NOT NULL DEFAULT now()
);

-- Append-only outcome events — source-yield + cost-per-producing-affiliate.
CREATE TABLE prospect_outcomes (
  id                    text PRIMARY KEY,
  merchant_id           text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  prospect_id           text NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  relationship_id       text REFERENCES affiliate_relationships(id),
  source_type           text NOT NULL,
  label                 text NOT NULL,
  produced_revenue_cents bigint NOT NULL DEFAULT 0,
  ts                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prospect_outcomes_merchant_idx ON prospect_outcomes(merchant_id, source_type, label);

-- Booked calls with A-tier prospects (the managed, human-closed track).
CREATE TABLE meetings (
  id            text PRIMARY KEY,
  merchant_id   text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  prospect_id   text NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  owner_user_id text,
  scheduled_at  timestamptz,
  status        text NOT NULL DEFAULT 'requested',
  booking_ref   text,
  booking_url   text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_merchant_status_idx ON meetings(merchant_id, status);

-- Per-merchant autonomous-engine control state.
CREATE TABLE automation_states (
  id                     text PRIMARY KEY,
  merchant_id            text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  status                 text NOT NULL DEFAULT 'off',
  auto_send_min_score    numeric NOT NULL DEFAULT 70,
  hitl_tier              text NOT NULL DEFAULT 'A',
  meeting_tier           text NOT NULL DEFAULT 'A',
  sourcing_limit_per_cycle integer NOT NULL DEFAULT 20,
  last_cycle_at          timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Global + per-merchant suppression (one-click unsubscribe honored everywhere).
CREATE TABLE suppression (
  id          text PRIMARY KEY,
  merchant_id text REFERENCES merchants(id) ON DELETE CASCADE,
  email       text,
  domain      text,
  reason      text NOT NULL,
  scope       text NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suppression_email_idx ON suppression(lower(email));

-- ---- API surface ------------------------------------------------------------
CREATE TABLE api_keys (
  id           text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,
  hashed_key   text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

CREATE TABLE webhook_subscriptions (
  id          text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  url         text NOT NULL,
  events      text[] NOT NULL DEFAULT '{}',
  secret      text NOT NULL,
  status      text NOT NULL DEFAULT 'active'
);

-- ---- Future MLM engine (not built initially) -------------------------------
CREATE TABLE volume (
  id           text PRIMARY KEY,
  affiliate_id text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  period       text NOT NULL,
  pv_cents     bigint NOT NULL DEFAULT 0,
  gv_cents     bigint NOT NULL DEFAULT 0
);

CREATE TABLE ranks (
  id           text PRIMARY KEY,
  affiliate_id text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  period       text NOT NULL,
  rank         text NOT NULL,
  qualified    boolean NOT NULL DEFAULT false
);
