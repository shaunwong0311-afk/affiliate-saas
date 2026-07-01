# Email Outreach — Design Spec

Status: **FINALIZED v1 — approved direction; ready to build Phase 1.** Scope: make the
recruitment engine actually **send, personalize, and process replies** as the merchant,
with **dead-simple mailbox onboarding**. The outreach *engine* — sequencing, send-windows,
warmup, mailbox rotation, bounce/complaint circuit breaker, two-track reply router,
suppression, CAN-SPAM/unsub, geo-gating — **already exists**. This spec covers the missing
"connect to reality" + "personalize per affiliate" + "easy setup" layers.

Product framing: this is **warm, personalized, relationship recruitment** — NOT cold
blasting. Outreach goes from the merchant's **real mailbox** (their reputation + two-way
inbox → best deliverability and reply rates). A dedicated-domain relay (SES) is a deliberate
*scale* rail added later, never the default.

---

## 1. Goals

- **Send as the merchant**, from their real inbox.
- **One-click / minimal setup** — the merchant should rarely, if ever, see a raw SMTP form.
- **Per-affiliate personalization** with a **client-selectable plan** (template / hybrid /
  LLM), metered and **billed differently**.
- **Process replies** (stop emailing people who answered; route them; convert positives to
  portal-ready affiliates).
- **No long approval bottleneck to launch.**
- Keep the discipline: verified contacts, suppression, unsubscribe, geo-gating, never
  contact existing affiliates.

## 2. Connection strategy — OAuth-first, SMTP as the fallback

The lesson from how every sales/outreach tool does this: **OAuth is what makes onboarding
easy; raw SMTP is the rare fallback, not the front door.** Most business email — even on a
custom domain — is Google Workspace or Microsoft 365 underneath, so OAuth covers far more
than it appears. The trick is to **auto-detect the provider and route the merchant to the
easiest path** (see §3).

Rails, by ease and coverage:

| Merchant's email is on… | Rail (how we connect) | UX | Approval | Phase |
|---|---|---|---|---|
| Microsoft 365 / Outlook / Hotmail | **MS Graph OAuth** (`Mail.Send`) | one-click | publisher verify (free) | **1** |
| Google Workspace / Gmail | **Gmail app-password wizard** (SMTP) now; Gmail API OAuth later | 3-step wizard → one-click later | none now / CASA later | **1** / 3 |
| Self-hosted (cPanel/Rackspace/GoDaddy/Namecheap/Zoho/Fastmail) | **Generic SMTP+IMAP**, pre-filled by autodetect | email + password | none | **1** |
| Wants volume / poor host deliverability | **Amazon SES** dedicated domain (+ DNS automation) | guided | DNS records | **2** |
| Workspace, true one-click Gmail | **Gmail API OAuth** (`gmail.send`) | one-click | **weeks + CASA $1–4.5k/yr** | **3** |

The generic **`SmtpSender`** is foundational regardless — it's the transport for both
self-hosted mailboxes AND the Gmail app-password path — but most merchants reach it
indirectly (autodetected/pre-filled), not via a bare form.

## 3. Smart Connect onboarding (the easy-setup UX) — Phase 1

The single most important UX: the merchant enters their email (we usually already have it),
and we **detect the right method via an MX-record lookup** and route automatically.

```
Merchant email ─► MX lookup ─►
  ├─ MX = Microsoft (outlook/office365)  ─► "Connect Microsoft"  (OAuth, one-click)
  ├─ MX = Google (Workspace/Gmail)        ─► "Connect Google":
  │                                            • now → guided APP-PASSWORD wizard (3 steps)
  │                                            • later → one-click OAuth (after CASA)
  ├─ MX = known host (Zoho/GoDaddy/…)      ─► SMTP form PRE-FILLED from a preset; user types password
  └─ MX = unknown                          ─► SMTP form, host/port via autodiscovery
                                              (autoconfig / mail.{domain} / SRV), user confirms + password
```

- **Provider presets + autodiscovery** so a self-hosted merchant only enters **email +
  password** (we fill host/port). Fallback: a "pick your provider" dropdown with per-provider
  screenshots.
- **Gmail app-password wizard**: inline steps with screenshots — enable 2-Step Verification →
  generate an app password → paste. (~3 steps, not a raw SMTP form.)
- **Always end with a live check**: send a test to the connected address + verify IMAP login;
  show a green "Connected" state or a precise error.
- **DNS automation (Phase 2)** for the SES/domain path: Entri-style or registrar-API flow to
  auto-add SPF/DKIM/DMARC so the merchant clicks instead of editing DNS by hand.
- **Provisioned/managed inboxes**: explicitly OUT of scope for v1 (that's the cold-blast model
  and not "send as the merchant"); revisit only as an optional add-on.

**Approval reality (why the order above):**
- **Microsoft** — `Mail.Send` is user-consentable (no admin consent by default), **no security
  audit**; publisher verification is free and ~minutes once the Microsoft Partner account
  exists (standing up that Partner account the first time is the only slow part, ~days, one-time).
- **Google** — `gmail.send` is a RESTRICTED scope → brand verification + **annual CASA audit**
  (~4–8 wks, ~$1–4.5k/yr); testing mode caps at 100 users with **7-day** refresh tokens → not
  production-viable. So Gmail uses the **app-password wizard at launch**; CASA is a parallel
  Phase-3 track for true one-click.
- **Outlook/M365 basic-auth SMTP is now fully RETIRED** (Exchange Online finished the cutover ~Apr 30, 2026) → Outlook/M365 mailboxes **require Graph OAuth**; there is NO SMTP fallback for them. Gmail app-passwords still work; self-hosted SMTP still works. So the SMTP rail covers **cPanel/host email + Gmail**, NOT Microsoft.

## 4. Architecture

### 4.1 Provider-agnostic sender resolution
Replace the single global `deps.mailer` with a **per-send resolver**:

```
resolveMailboxSender(ctx, mailbox): Promise<MailboxSender>
  - load credentials from SecretStore by mailbox.credentialsRef
  - smtp         → SmtpSender(host, port, user, pass)   [self-hosted + Gmail app-password]
  - microsoft    → refresh access token → MicrosoftGraphSender(token, http)
  - ses          → SesSender(region, from-domain, creds)            [Phase 2]
  - gmail_oauth  → refresh access token → GmailSender(token, http)  [Phase 3]
  - (dev)        → MockMailboxSender
```

`send()` resolves the campaign's mailbox (rotation via existing `pickSendableMailbox`) →
`sender.send(email)`. Tokens/passwords live ONLY in the `SecretStore` (encrypted), referenced
by an opaque `credentialsRef` — never in entity rows. Replies for the SMTP rail use the
existing `ImapReplyIngestion`.

### 4.2 Credential / token lifecycle
- `MailboxCredentials` (SecretStore JSON): `{ kind, accessToken?, refreshToken?, expiresAt?,
  appPassword?, smtpHost?, smtpPort?, imapHost?, ... }`.
- **Refresh on demand**: before a send, if `expiresAt < now+60s`, refresh via the provider's
  token endpoint; persist the new token + expiry.
- Refresh/auth failure → mailbox `status:"error"`, pause its campaigns, surface a "reconnect"
  prompt (circuit-breaker-adjacent).

### 4.3 Data-model changes
- `Mailbox.provider` → `"microsoft" | "smtp" | "ses" | "gmail_oauth"` (gmail/host SMTP all use
  `"smtp"`); add `connectedAt`, `lastError?`, `fromName`, `detectedProvider?` (MX hint).
- New `MailboxOAuthState` (short-lived CSRF/PKCE state for the consent round-trip).
- `Merchant.personalizationPlan: "template" | "hybrid" | "llm"` (default `"hybrid"`).
- `SendingDomain` gains real DNS verification (Phase 2).
- `OutreachMessage` += `providerMessageId`, `threadId`, `clickedAt?`, `personalizationMode`,
  `llmTokensIn/Out` (billing).

## 5. Personalization (client-selectable, billed)

LLM available throughout; the merchant picks a plan, **billed differently**. Resolved per
prospect at send-build time:

| Plan | A-tier | B-tier | C-tier | ~LLM cost/email | Billing |
|---|---|---|---|---|---|
| `template` | tokens | tokens | tokens | $0 | cheapest |
| `hybrid` (default) | **LLM** | tokens | tokens | ~$0.001 avg | mid |
| `llm` | LLM | LLM | LLM | ~$0.001–0.005 | premium |

- **LLM body** = the existing cheap-LLM client (Grok/Haiku), prompted with the prospect's
  **real evidence**: their affiliate links, the **specific competitor** they promote, niche,
  reach, identity-graph platforms — cites concrete facts.
- **Compliance envelope is system-owned**: the LLM writes the body; the system always adds the
  CAN-SPAM footer, unsubscribe, merchant address, and applies geo-gate + suppression + the
  existing-affiliate guard.
- **HITL gate** stays for A-tier (LLM drafts → operator approves).
- **Billing model: plan tier + metering (both).** The plan gates *which* prospects get an LLM
  call; per-message `llmTokensIn/Out` → a `usageEvents{kind:"personalization"}` row so usage is
  attributable for tiered pricing and any overage.
- **Preview + test-send**: render the exact email for a sample prospect; "send test to myself."
- **A/B** subject/variant testing → Phase 3.

## 6. Reply ingestion (Phase 1)

Without this, replies are invisible and we keep emailing people who said yes.
- **Microsoft**: Graph change-notification webhook → fetch message → `parseInboundWebhook` →
  reply-router.
- **SMTP rail (self-hosted + Gmail app-password)**: **IMAP poll** (`ImapReplyIngestion`) every
  **~5 min** (default cadence) via a scheduler worker.
- **Gmail OAuth (P3)**: `users.watch` + Pub/Sub. **SES (P2)**: SES→SNS→webhook.
- **Threading**: store `providerMessageId`/`threadId`; set `In-Reply-To`/`References` on
  follow-ups.
- Reply → two-track router (self-serve vs AI-SDR + meeting) → hard-stop the sequence → on
  positive, **convert prospect → affiliate + relationship** so they can magic-link into the
  portal. (Verify this seam end-to-end — it's the bridge from discovery to a logged-in affiliate.)

## 7. Deliverability hardening (Phase 2 — mostly exists, finish it)

- **Bounce/complaint feedback ingestion** (async): Graph / SES-SNS webhooks + SMTP DSN parsing
  → suppression + the existing circuit breaker.
- **DKIM/SPF/DMARC check on connect** → populate `SendingDomain.*Status`; warn (don't hard-block)
  when a self-hosted domain is unauthenticated, with a "fix it" guide.
- **Warmup automation** (drive the existing `effectiveDailyCap` ramp on a schedule).
- **Pre-send verify**: free MX (exists) + optional per-address verify (~$0.004) for risky addresses.
- **Human pacing**: per-send jitter + spread across the send window.
- **SES dedicated-domain rail** + DNS automation.

## 8. Compliance (exists — keep)

CAN-SPAM footer, one-click unsubscribe (real endpoint), STOP handling, EU/Canada geo-gate,
merchant physical address, existing-affiliate + suppression guards. **No open-tracking pixels**
by default (deliverability + privacy) — link tracking only on our own redirector for
signup/unsubscribe links. DKIM/SPF/DMARC verification in Phase 2.

## 9. Observability

Per campaign / mailbox / sequence-step / variant: **sent, delivered, bounced, complained,
clicked, replied, positive, meeting-booked, recruited**, and **cost-per-recruit** (LLM +
verify + infra). Deliverability panel: bounce/complaint rates vs the 2% / 0.3% thresholds +
circuit-breaker state. (Triage `byBand` + source-yield already feed the funnel view.)

## 10. New/changed API routes

- `POST /mailboxes/detect` → MX lookup → recommended method + prefilled SMTP/IMAP settings
- `POST /mailboxes/:id/connect/microsoft` → OAuth consent URL [P1] · `GET /oauth/microsoft/callback`
- `POST /mailboxes/:id/credentials/smtp` → store SMTP/app-password creds [P1]
- `POST /mailboxes/:id/test` → send a test + verify IMAP login
- `POST /mailboxes/:id/connect/google` + `GET /oauth/google/callback` [P3]
- `POST /campaigns/:id/preview` → render the email for a sample prospect (incl. LLM)
- `PATCH /merchants/:id` → set `personalizationPlan`
- `POST /webhooks/graph`, `POST /webhooks/ses` → reply + bounce/complaint ingestion [P1/P2]
- IMAP-poll reply worker registered in the scheduler [P1]

## 11. Build phases

1. **Go-live core** — `SmtpSender` + `MicrosoftGraphSender` (live); **Smart Connect** (MX
   detect → route → presets/wizard → test); per-send resolver + token refresh + SecretStore
   creds; LLM per-affiliate personalization with plan gate + metering + preview/test-send;
   reply ingestion (IMAP poll + Graph webhook) + threading; **prospect→affiliate conversion seam**.
2. **Deliverability** — SPF/DKIM/DMARC check + warn; bounce/complaint ingestion; warmup
   automation; pre-send verify; jitter; **SES rail** + DNS automation.
3. **Effectiveness + scale** — A/B; send-time/timezone optimization; value-add follow-ups;
   per-campaign analytics; **Gmail API OAuth after CASA**; dedicated multi-inbox domains.

## 12. Cost summary (per merchant)

- Sending (P1, merchant mailbox): **$0 marginal**.
- SES rail (P2/scale): ~$0.10/1k emails; secondary domain ~$12/yr.
- Transactional ESP (magic links/notices — not cold): **Resend** (free ≤3k/mo, ~$20/mo at 50k).
- Per-address verify (optional): ~$0.004/verify.
- LLM personalization: ~$0.001–0.005/email — **metered + billed by plan**.
- Microsoft publisher verification: **free**. Google CASA (P3 only): **~$1–4.5k/yr**.

## 13. Decisions — LOCKED for v1

1. **Connection**: OAuth-first via **Smart Connect** (MX autodetect). Phase-1 rails =
   **MS Graph OAuth + generic SMTP (incl. Gmail app-password wizard)**. ✅
2. **SES**: **merchant-owned secondary domain** (clean reputation separation), Phase 2. ✅
3. **Personalization billing**: **plan tier + per-message metering (both)**. ✅
4. **Transactional ESP**: **Resend** for production magic links / notices. ✅
5. **SMTP reply ingestion**: **IMAP poll every ~5 min**. ✅
6. **Gmail one-click**: **app-password wizard at launch; CASA deferred** (not funded now). ✅
7. **OAuth rails: BUILD ourselves, ship unverified, no broker** (see §14). Publisher
   verification is optional/deferred — the unverified warning is a non-issue for our
   already-onboarded, usually-self-admin merchants (see §15). ✅

All v1 decisions are settled — no open sign-offs. Building Phase 1.

**Action items (calendar-time, start in parallel with the build):**
- Optional/deferred: stand up the **Microsoft Partner account** → publisher verification.
  NOT required to launch (see §15) — only buys a cleaner consent screen + non-admin
  self-consent in locked-down tenants.
- Google CASA: **deferred** (Gmail uses the app-password wizard at launch).

## 14. Build vs. buy the OAuth rails (evaluated → BUILD)

We can either build the Google/Microsoft OAuth flows ourselves or send users through a
**unified-email-API broker** whose own app is already a verified publisher (so we skip
publisher verification + the "unverified" warning). Verified pricing:

| Broker | Price | Removes our verification? |
|---|---|---|
| Aurinko | ~$1/account/mo | ⚠️ default is bring-your-own-app → no |
| Nylas (Hosted OAuth) | $15/mo + $2/account/mo | ✅ (their verified app); enterprise-leaning |
| Unipile | €5/account/mo (min €49/mo) | ✅ (their verified app); self-serve |

**Decision: BUILD ourselves, ship unverified, no broker (for now).** Rationale: a broker is
a recurring per-merchant COGS line (~$2–5.5/mo each) that grows linearly; and the thing it
removes — the "unverified" warning — barely matters for us (see §15). Revisit a broker only
if we stop wanting to maintain OAuth plumbing or move upmarket to locked-down enterprises.

## 15. Entity / verification reality (Malaysian sole proprietor, SSM)

- **Launch needs ZERO third-party verification.** The SMTP rail (cPanel/host + Gmail
  app-password) needs no DUNS, no Partner account, no CASA. Microsoft Graph OAuth **functions
  while unverified** — the consent screen shows an "unverified" warning, but our merchant is an
  already-onboarded customer doing a deliberate setup step, so it's a clickable speed bump,
  not a wall. It only ever appears on the **Outlook/M365 slice** (SMTP merchants see no
  consent screen at all).
- **Free polish:** set a **publisher domain** on the app (no Partner account, no DUNS) → the
  consent screen shows our domain instead of the word "Unverified."
- **Only hard-blocked case:** a non-admin user in a locked-down M365 tenant that restricts
  consent to verified publishers. Mitigations: the merchant (usually their own admin)
  self-grants admin consent; or, later, full publisher verification / a broker. Not our
  typical merchant.
- **If/when we DO pursue Microsoft publisher verification:** sole proprietors are eligible;
  DUNS is OPTIONAL — use the **Manual document-upload path with the SSM ROB certificate** and
  enter the legal name **exactly as on the SSM cert** (this also dodges the sole-prop DUNS
  quirk, where D&B records the OWNER's name rather than the trade name). Requires a
  work/org tenant + custom-domain email; the **publisher DOMAIN can be our SaaS domain** (it's
  decoupled from the legal name — only the *publisher name* shown on consent reflects the SSM
  legal entity). DUNS, if wanted, is free via D&B Malaysia (~30 working days).
- **Google CASA** (true one-click Gmail): deferred; app-password wizard covers Gmail at launch.

---

## 16. Build log + research decisions + REMAINING QUEUE (resume here after compaction)

**Built + committed (green, 359 tests):** Phase 1 (SMTP send-as-merchant, Smart Connect,
personalization plans, conversion seam, inbound `applyToJoin`, reply processing) · competitive-gap
A–D (List-Unsubscribe RFC 8058, DKIM verify, cadence cap, activation metrics + fast-start,
send-time/timezone, A/B variants, seed-send, DM-assist + `dm-followup` queue) · **mailbox OAuth
connect flow** (`integrations/oauth.ts`; MS Graph + Gmail; unverified-OK; resolver token refresh) ·
**IMAP reply poller** (`integrations/reply-ingestion.ts` `ImapReplyIngestion` — real, imapflow+
mailparser optional deps, PEEK-only so the merchant's inbox flags are untouched; `replyPoller` dep +
`ingestReplies` orchestration with Message-Id dedup + per-mailbox `lastPolledAt` cursor; wired into
`tickScheduler`; `POST /recruitment/ingest-replies` on-demand trigger) · **activation welcome email**
(`core/recruitment/activation-email.ts` pure builder + `commissionLineFromOffer`/`firstSaleBonusText`;
`api/services/activation-email.ts` `sendActivationEmail` — passwordless 7-day magic link, pre-generated
site-wide tracking link, minted personal referral/attribution code, REAL commission line + REAL
first-sale bonus only when configured, 14-day fast-start; idempotent via `relationship.activationEmailSentAt`;
fired on approve / auto-apply / inbound join / prospect conversion) · **AI-SDR reply handler**
(`core/recruitment/ai-sdr.ts` — `topicGate` (structural human-gate on rate/custom-deal/legal/meeting/
payment), `buildMerchantKb` + `serializeKb` (KB-in-context, not RAG), `answerFromKb` (deterministic
grounded answers for commission/cookie/payout/how-to-join + FAQ keyword match), `buildGroundedSdrPrompt`+
`isNeedsHuman` (LLM answers ONLY from KB else declines); `integrations/notifier.ts` `Notifier` port +
`StubNotifier`/`SlackWebhookNotifier`; `db` `MerchantFaq`+`Handoff` entities + `AutomationState.aiSdrMode`;
`reply-router.ts` topic-gate → grounded answer → handoff packet + notify, HITL(default)/autopilot;
routes: `GET /recruitment/handoffs`, `/handoffs/:id/resolve`, `GET|POST|DELETE /recruitment/faqs`,
`aiSdrMode` in automation PUT). NOTE deferred: physical auto-SEND of autopilot answers (needs the
outbound-reply/threading transport) — today autopilot marks `autoSend:true` + HITL queues a suggested reply.

**REMAINING QUEUE — priority order (this is the "what's next"):**

1. **#6 per-client deliverability monitoring** + auto-pause: async bounce/complaint ingestion, per-mailbox
   health (surface `deliverabilityHealth`), warmup-on-a-schedule, act (pause/throttle) on thresholds.
2. **#7 pre-send content gate** on EVERY personalized email (spam-word/link/length/subject scan + optional
   cheap-LLM "spammy/off-brand?" check). NOTE: seed-test = infra/placement on a representative sample
   (already built); this per-email gate is the complement for unique LLM content.
3. **#5 DM as an automated sequence step** — a `channel:"dm"` step auto-creates a fully-prepared DM task
   (drafted message + deep link + context) so the human only presses send. Needs a persisted DM-task
   entity + scheduler wiring. (Semi-assisted only — NEVER auto-DM; ToS.)
4. **#8 web dashboards** (activation, deliverability, funnel, A/B, DM-queue) with charts. Endpoints exist
   (`/recruitment/activation`, `/campaigns/:id/ab`, `/dm-followup`, `deliverabilityHealth`). Big frontend.

**Deferred/lower:** #3 live cadence validation (needs real keys); #10 first-party advocate capture (only
merchants with a customer base); SES dedicated-domain rail; calendar + payout rails.
