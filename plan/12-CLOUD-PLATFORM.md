# 12 — Cloud Platform (`apps/api`, `apps/render-worker`, `apps/web`)

The local product must be fully usable offline and free. The cloud adds: accounts,
cloud/fast rendering, share links, hosted AI (LLM agent without own key, TTS, image/video
generation, music), team features, and billing.

## 1. Services

| Service | Stack | Responsibility |
|---|---|---|
| `api` | Hono (Node 22), Drizzle ORM, Postgres 16, Redis | auth, projects, uploads, render jobs, publish, billing, usage, AI proxy |
| `render-worker` | Docker image: Debian bookworm-slim + chrome-headless-shell (pinned) + ffmpeg 7 static + fonts (Noto, Inter, Roboto, emoji) + `@editnce/producer` | pulls jobs, renders shards, uploads outputs |
| `web` | Next.js (App Router) or Vite SSR — pick Next.js | marketing, docs, catalog site, share pages `/v/:slug`, dashboard, checkout |
| storage | Cloudflare R2 (S3 API) | bundles, assets, outputs, previews |
| CDN | Cloudflare | player bundle, registry, published videos |

## 2. Data model (Postgres)
```
users(id, email, name, avatar_url, created_at)
accounts(id, user_id, provider, provider_account_id)           -- oauth links
orgs(id, name, plan, stripe_customer_id, created_at)
memberships(org_id, user_id, role)                             -- owner|admin|member
api_tokens(id, user_id, name, token_hash, last_used_at, scopes, created_at, revoked_at)
device_codes(device_code_hash, user_code, user_id?, scopes, expires_at, approved_at)
projects(id, org_id, name, latest_bundle_id, created_at, updated_at)
bundles(id, project_id, sha256, size, storage_key, file_manifest jsonb, created_at)
blobs(sha256 pk, size, storage_key, created_at)                -- content-addressed asset dedupe
render_jobs(id, org_id, project_id, bundle_id, options jsonb, status, progress, shards int,
            output_key, error jsonb, frames, duration_s, cost_credits, created_at, started_at, finished_at)
render_shards(job_id, idx, frame_from, frame_to, status, worker_id, output_key, attempts)
publications(id, slug, org_id, render_job_id, visibility, title, poster_key, views, created_at)
usage_events(id, org_id, kind, quantity, unit, meta jsonb, created_at) -- render_seconds, llm_tokens, tts_chars, image_gen, video_gen_seconds
credit_ledger(id, org_id, delta, reason, ref, created_at)
webhooks(id, org_id, url, secret, events[], created_at)
```

## 3. Auth
- Web: email magic link + Google/GitHub OAuth (use Better Auth or Lucia-style session cookies; httpOnly, SameSite=Lax).
- CLI/Desktop: **OAuth 2.0 Device Authorization Grant (RFC 8628)**:
  1. `POST /oauth/device/code {client_id:"editnce-cli", scope}` → `{device_code, user_code: "WDJB-MJHT", verification_uri: "https://editnce.dev/activate", verification_uri_complete, expires_in: 900, interval: 5}`.
  2. CLI prints code, opens browser.
  3. CLI polls `POST /oauth/token {grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code}` → `authorization_pending` | `slow_down` | `{access_token, refresh_token, expires_in}`.
  4. Store at `~/.config/editnce/credentials.json` (mode 0600) or OS keychain (desktop).
- API tokens for CI (`EDITNCE_API_TOKEN`), hashed with SHA-256 at rest, shown once.

## 4. Cloud render flow
1. CLI/Studio builds a bundle manifest: every project file → sha256, size (exclude `renders/`, `node_modules/`, `.git/`, caches).
2. `POST /v1/bundles/prepare {files:[{path,sha256,size}]}` → which blobs are missing + presigned PUT URLs. Upload missing (parallel 6, multipart for > 100 MB). `POST /v1/bundles/commit` → `bundle_id`.
3. `POST /v1/renders {project_id?, bundle_id, options}` → job (validate options; estimate credits from duration × resolution × fps; reject if insufficient).
4. Scheduler: compile + probe on one worker ("plan" step) → total frames → shard count = `clamp(ceil(frames / 450), 1, 32)` (≈15 s at 30 fps per shard) → enqueue shard jobs (BullMQ queue `render-shards`) + an `audio` job.
5. Workers: download bundle (blob cache on local disk keyed by sha256), render frame range to chunk (closed GOP, engine §6.3), upload chunk.
6. Finalize job: concat chunks + mux audio + faststart, upload output, ffprobe verify, mark done, emit webhook `render.completed`, record usage `render_seconds = duration × resolution factor (1080p=1, 4K=4) × fps/30`.
7. Progress: workers publish to Redis pub/sub; API exposes `GET /v1/renders/:id/events` (SSE).
8. Retries: shard attempts ≤ 3; job timeout = 10× video duration + 10 min.
9. Determinism across machines: all workers same image digest; job records image digest.

Workers autoscale on queue depth (Fly Machines / Cloud Run jobs / k8s KEDA). Each worker
container: 4 vCPU / 8 GB, 2 concurrent shards.

## 5. Publish & share
- `POST /v1/publications {render_job_id, visibility, title}` → slug.
- Share page `/v/:slug`: `<fc-player video-src=mp4>` + title + download (if allowed) + "Made with Editnce" + OG tags (`og:video`, poster).
- Optional "live" share: upload compiled bundle; page uses live `<fc-player src>` (interactive decks).
- Visibility: public, unlisted (default), private (org members, signed URLs 1 h).

## 6. AI proxy (hosted plan)
- `POST /v1/ai/chat` (streaming, Anthropic/OpenAI passthrough with our key, tool schemas allowed), `POST /v1/ai/tts`, `/v1/ai/image`, `/v1/ai/video` (async job), `/v1/ai/music`, `/v1/ai/transcribe`.
- Every call: auth → check credits → call provider → meter usage → ledger debit. Rate limit per org (token bucket in Redis). Log prompt metadata only (not content) unless user opts into history.

## 7. Billing (Stripe)
- Plans: **Free** (local everything; cloud: 10 render-minutes/month 1080p, watermark-free, 3 publications), **Creator** (monthly credits for render + AI, 4K, priority queue), **Pro/Team** (more credits, seats, brand kits, API access). Exact prices TBD by business.
- Stripe Checkout + Customer Portal; webhooks (`checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.paid`) update `orgs.plan` and grant monthly credits.
- Overage: metered usage reported to Stripe usage records daily.

## 8. Public API (for developers)
`/v1/renders`, `/v1/bundles`, `/v1/publications`, `/v1/templates/:name/render` (render a registry/example template with variables — the "video API" use case), webhooks. OpenAPI spec generated from Hono route schemas (zod-openapi). SDK: `@editnce/cloud` (typed client).

## 9. Legal/compliance checklist (must be done before public launch)
- Our own license choice: Apache-2.0 for local core packages (or source-available) and proprietary for cloud/desktop — decide and add LICENSE files.
- `NOTICE` lists any Apache-2.0-derived code (from the reference repo), fonts (OFL), models (licenses), SFX (CC0).
- **GSAP (decided approach)**: GSAP is free for commercial use under Webflow's "Standard No Charge License" (https://gsap.com/community/standard-license/), but that license prohibits using it in "tools that allow users to build visual animations without code" competing with Webflow's visual animation builder. Our approach:
  1. GSAP is used **only as code**: authored by users in the Code tab or written by the AI agent (GSAP's FAQ explicitly permits AI-generated code). Rendering such compositions is a permitted use.
  2. Studio's no-code animation features (keyframes, drag-to-animate, ease picker, presets) **never generate or edit GSAP**; they write `data-fc-motion`, rendered with the browser's Web Animations API (01 §6b, 02 §5, 08 §4). Enforced by the 08 §12 "no Studio action modifies any `<script>`" test.
  3. Never remove or alter GSAP's copyright notices/branding in vendored files.
  4. Before launch: email Webflow describing the product and request written confirmation (the license allows "prior written consent"); keep the reply on file. Have counsel review if no reply.
- Model licenses (whisper: MIT; matting model: verify commercial use), TTS provider ToS, stock media ToS (attribution), music licensing.
- Privacy policy, ToS, DPA, GDPR export/delete endpoints, cookie consent.
- No telemetry without opt-in.

## 10. Acceptance criteria
- Device login end-to-end against local stack (docker-compose: postgres, redis, minio, api, worker).
- Cloud render of fixture: output frame-identical to a local Linux Docker render; shards > 1 used for a 60 s fixture.
- Blob dedupe: second upload of unchanged project uploads 0 bytes.
- Stripe test-mode subscription grants credits; render debits; insufficient credits blocks.
- Share page plays and has valid OG tags.
