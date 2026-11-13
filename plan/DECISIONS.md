# DECISIONS — spec decisions made during implementation

## 2026-11-13 — Studio chat agent model: DeepSeek V4.1 Flash

**Decision:** the hosted chat agent (apps/web `/api/chat` → `@donova/studio-server/agent`)
runs on **DeepSeek V4.1 Flash** (`deepseek-flash`) via DeepSeek's
Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`), thinking
mode disabled.

**Why not Claude Haiku 5.5 ($0.10/$0.50):** Haiku was cheaper on paper and a
zero-code swap, but the owner chose DeepSeek for cost headroom at scale
(off-peak $0.15/$0.60) and product preference. The provider is env-configurable
(`DONOVA_LLM_BASE_URL`/`DONOVA_LLM_API_KEY`/`DONOVA_LLM_MODEL`, Anthropic envs
as fallback) so switching back is a redeploy, not a code change. Revisit if
tool-use quality disappoints — Haiku remains the fallback pick.

**Verified:** `/anthropic/messages` returns 401 (exists); DeepSeek docs confirm
client tools + `tool_use`/`tool_result` + `thinking:{type:"disabled"}` on that
protocol. Rules fallback verified working with no key.

**Usage caps (same date):** trial = 25 lifetime chats; paid = 300 chats/month +
4M-token monthly ceiling; owners uncapped. Counters live on the GCS
`subscribers/<sha256>.json` record (`trialChats`, `usage{month,chats,tokensIn,
tokensOut}`); enforced + returned (`chatRemaining`) in `/api/chat`. Soft-cap
caveat: GCS read-modify-write can lose counts across concurrent containers.

## 2026-11-13 — Cloud media verbs run on the render worker, not the web container

**Decision:** the cloud agent's media commands (transcribe/cuts/captions/
scaffold/add/probe/snapshot/render) execute in `apps/render-worker` via a new
`POST /run` endpoint, not in `apps/web`. The web app orchestrates only:
materialize needed files, invoke the worker with an OIDC-signed request, pull
`filesWritten` back into the web mirror, flush agent `changed` files to GCS.

**Why the worker:** it already carries ffmpeg + Chrome + all built packages +
the registry in-image — the web container ships none of those and can't do
parakeet/ffmpeg/Chrome work at Cloud Run web latency anyway. One runtime for
all heavy verbs keeps the web image thin.

**Shape:** `/run` takes `{userPrefix, cmd, args, filesNeeded}` and returns
`{ok, data, filesWritten}`; worker calls package-level functions directly
(`@donova/media` pure cores, `@donova/engine` scaffold, `@donova/producer`
render-job enqueue) — no CLI subprocess per verb. `captions` logic moved to
pure `generateCaptionsHtml` in `@donova/media` so CLI + worker share it.

**Open follow-ups:** (1) `/run` has no own auth layer — it relies on Cloud
Run invoker IAM; confirm `donova-render-worker` deploys with
`--no-allow-unauthenticated` before launch. (2) `filesNeeded` today pulls the
whole project mirror minus a skip list; per-file pulls can shrink worker cold
time on big projects. (3) Parakeet prefetch happens at image-build; a missing
`~/.cache/donova` model on first run would cold-start a verb ~20s.

## 2026-11-13 — Payment processor: Stripe (replaces Helcim)

**Decision:** Donova Cloud billing uses Stripe hosted Checkout + webhooks;
Helcim is fully removed (modal, lib, initialize route, deploy secret refs).

**Shape:** `POST /api/billing/checkout` creates a subscription Checkout
Session for `STRIPE_PRICE_ID` (Donova Creator $11.00/mo) prefilled with the
user email; success lands on `GET /api/billing/confirm?session_id=` which
verifies with `sessions.retrieve` (never trusts client state), records the
subscriber, sets account cookies, redirects to /dashboard. `POST
/api/billing/webhook` is the authoritative lifecycle writer —
`checkout.session.completed` activates; `customer.subscription.updated/deleted`
maps active|trialing → activate, canceled|unpaid|incomplete_expired →
deactivate; past_due deliberately keeps access during card retry; failed
invoices only log for now (no dunning UX yet). Email rides in session +
subscription metadata so webhooks resolve the account without a lookup.

**Why the webhook is authoritative:** the confirm redirect is best-effort UX
(users close tabs, GCS writes can fail); Stripe retries webhook delivery for
~3 days, so the subscriber record converges to truth regardless.

**Live resources:** account acct_1UbQ1EL5oy3FSbVs (US, charges+payouts on),
price `price_1UbQBgL5oy3FSbVszyQ3tpD3`, webhook `we_1UbQBoL5oy3FSbVsitHT9VyF`
→ `/api/billing/webhook`. Secrets in Secret Manager; `STRIPE_PRICE_ID` is a
plain env var (not secret). stripe@23.1.0 pinned (≥7-day rule).

**Follow-ups:** customer-portal link for self-serve cancel; dunning email on
invoice.payment_failed; webhook handler idempotency (events can redeliver —
current writes are overwrite-idempotent, fine); Stripe tax config if needed.
