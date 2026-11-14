# STATUS — what exists today (read before building)

Last updated: 2026-11-13 (multi-user Studio isolation verified — see §-9). Update this file whenever you finish an MV task.

## -9b. Cloud agent: provider-agnostic LLM + per-user chat caps (2026-11-13)

The studio-server `Agent` tool loop now targets any Anthropic-Messages API:
`DONOVA_LLM_BASE_URL`/`DONOVA_LLM_API_KEY`/`DONOVA_LLM_MODEL` (Anthropic envs
accepted as fallback; no key → rules fallback unchanged). Thinking is sent as
`{type:"disabled"}` (DeepSeek thinking burns output tokens and breaks
`tool_choice`). Each `Turn` carries `usage{inputTokens,outputTokens}` summed
across rounds incl. cache reads. **Prod provider: OpenRouter** — its
Anthropic-compatible `POST /api/v1/messages` is verified end-to-end
(tool_use, `tool_choice:{type:tool}`, `thinking:{type:"disabled"}`,
`deepseek/deepseek-v4.1-flash`; usage tokens come back in Anthropic shape).
`deploy.sh` mounts `openrouter-api-key` → `DONOVA_LLM_API_KEY` and sets
base+model envs; `deepseek-api-key` remains as the automatic fallback (direct
`api.deepseek.com/anthropic`) — that key exists but its account had $0
balance at last check. Chat caps: trial 25 lifetime, paid 300/mo + 4M
tokens/mo, owners uncapped — counters on the GCS subscriber record, enforced
in `/api/chat` (429 `{code:"CHAT_LIMIT"}`), `chatRemaining` returned per
response.

## -9f. In-Studio chat bridge: the bottom-right pill now works hosted (2026-11-13)

The injected Studio chat pill (`donova-rebrand-chat-v1` in rebrand.ts) was
dead in prod: it computes `base = http://127.0.0.1:(location.port+1000)` —
on the run.app URL location.port is empty → the widget hit the *user's own
laptop*. Now `local ? 127.0.0.1:port+1000 : '/agent-bridge'` (same for the
annotate overlay + auto pill). studio-service proxies `/agent-bridge/*` →
the per-instance sidecar on `inst.port+1000`, after the same signed-session
gate; `POST /agent/chat` passes `chatGate.ts` (shared subscriber record —
dashboard + Studio chats draw from one pool; trial 25 lifetime, paid
300/mo + 4M tokens, owners uncapped).
Cloud mode (`DONOVA_CLOUD=1`, set in deploy.sh): sidecar pins the env-
configured endpoint (`DONOVA_AGENT_URL/MODEL/KEY_ENV` → OpenRouter OpenAI-
compat tool loop, `DONOVA_LLM_API_KEY` = mounted `openrouter-api-key`
secret); `/agent/setup` + `/stop` 403, `/agent/select` returns the pinned
endpoint (no local CLIs), `/auto` reports disabled; `run_command` allows
only `node $DONOVA_BIN …` (no shell/pipes — a prompt-injected `npx evil`
would run with the service account).
Sidecar tool loop now matches the cloud Agent contract: style.md inlined
every prompt (8KB), last-10-turns replay from `.donova/turns.json` (shared
file — Studio + dashboard chats share memory), Turn appended per chat
(changes/tools/usage), write_file refuses assets/media paths.
Verified: cloud-mode sidecar smoke test — tool calls for donova-CLI only,
style rules (1280×720/monospace/cyan/0.3s) applied, turns.json written.
**Deploy:** `bash apps/studio-service/deploy.sh` (rebuilds CLI chunk in
image — annotate hash changes with the sidecar code).

Follow-up (same day): first real user chat exposed three gaps — fixed:
- `run_command` charset rejected quoted paths (`probe "my clip.mp4"` →
  "not allowed"); `"`/`'` now allowed (substitution chars stay banned).
- Preview-process exit → pushes stopped AND next request re-pulled GCS
  over local, clobbering un-pushed agent edits. pullProject now only runs
  on first materialize (local tree is authoritative mid-session); pushes
  run for any known tree.
- Agent couldn't see footage → refused visual edits honestly. New
  `view_frame` tool: ffmpeg extracts a frame (≤768px jpeg) → vision model
  describes it (objects, 0-1 positions, legible text) → text back into the
  tool loop. `DONOVA_VISION_MODEL` env; prod uses
  `deepseek/deepseek-v4.1-flash-1017` (native image input, same OpenRouter
  key, ~$0.038/M in — a frame scan of 30 samples ≈ $0.002).
- chromium `--no-sandbox` added to check/snapshot launches on Linux so
  `donova check` works in the root-user container.
- buildPrompt now tells the agent to wire unreferenced media into the
  comp (`<video data-start data-duration>`) and use view_frame rather
  than inventing timecodes.

### Second production pass (2026-11-14) — real-footage request, verified

The user's real ask ("zoom in and follow the pomade jar at the handoff so
the brand name shows, then back to regular framing") ran the full loop in
prod. It exposed and fixed three more things:

- **Frame-scan economics.** First run issued 34 sequential `view_frame`
  calls and died at the 15-round cap with nothing written. `view_frame`
  now accepts `times[]` (≤8/batch, frames fetched+described in parallel,
  each labeled with its real timestamp); the vision fetch has an abort
  timeout; the tool-loop cap is 24 rounds. The successful run: 28 samples
  in 4 batched calls → `write_file` → `timeline` verify → `done`.
- **Push-loop crash (the big one).** `pushChanges` statSync'd files a beat
  after walking them; `.hyperframes/preview/<hash>.html` churns constantly,
  so ENOENT → unhandled rejection → **the whole multi-user service
  exited mid-chat** (sidecars are child processes — every live session
  died with it). Fixes: statSync guarded, `.hyperframes/preview/` excluded
  from pushes (regenerable artifacts), and the sync tick `.catch()`es —
  housekeeping must never take down the service.
- **Chrome was never in the path.** Both Dockerfiles installed
  chrome-headless-shell to `/opt/donova/chrome` but `ensureChrome()` scans
  `homedir()/.donova/chrome` → every check/render fell through to a ~100MB
  runtime download inside the agent's 60s `run_command` window →
  "Command failed". Install path fixed in both images; `donova doctor`
  now reports `✓ chrome-headless-shell@linux-141.0.7390.54` and `gate`'s
  runtime stage launches a real browser.

**Verified production result** (revision `donova-studio-00024-l2w`, trial
account `u-7cb3f88b84d3`, 10s 1080×1920 barbershop clip): the agent
probed, sampled 28 frames in 4 batches, measured jar positions per beat,
rewrote the GSAP camera track on `#cam` — push-in to 2.4× at 5.05s
(label only legible ~5.15–5.55s, *before* the handoff — it made that
judgment call itself and explained the deviation), held on the label,
followed the jar through the handover in 5 measured steps, pulled back to
full frame by 6.85s ahead of the ~6.95s cut. Every keyframe bounds-checked
against `cx,cy ∈ [0.5/s, 1−0.5/s]`. `donova timeline` + `gate` pass;
`index.html` + `.donova/turns.json` (5 turns) synced to GCS.

**Residual note:** `donova check` exits 1 when it *finds issues* (agent-
first CLI contract) — `run_command` used to report that as "Command
failed" and swallow the report. `execToolCmd` now returns captured
stdout+stderr on non-zero exit so the agent sees the actual check output.

### Export save-as (2026-11-14, rev `donova-studio-00026-cnk`)

Exporting dumped renders into `~/Downloads` under a `u-<uid>_<ts>` job-id
name with no user choice. Fixed on both download surfaces:

- **Studio render queue** (`donova-rebrand-export-v1` in rebrand.ts):
  capture-phase click interceptor on `button[aria-label^="Download "]`
  and any `a[download]` → `showSaveFilePicker` (native Save-As: user picks
  the folder AND the name) → fetch the `/api/projects/<pid>/renders/file/`
  URL → `resp.body.pipeTo(writable)`, aborts the partial write on failure,
  falls back to a normal download where the API is missing (Firefox,
  Safari) or the save fails. Suggested name strips the uid prefix →
  `donova-<YYYY-MM-DD>_<HHMMSS>.<ext>`.
- **Desktop files page** (`/api/desktop/download`): was a 302 to a bare
  GCS signed URL — no CORS (so no fetch→picker), no friendly filename,
  and `.dl` links played the video in-tab rather than saving. Now proxies
  bytes through the service with `Content-Disposition: attachment`, and
  the page's SAVE VIDEO links run the same picker flow.

### Studio layout: Assets-first + Annotate menu toggle (2026-11-14, rev `donova-studio-00027-2bf`)

Left column led with Compositions (upstream default) and the annotate
overlay had no on/off entry in the panels menu. `donova-rebrand-layout-v2`
in rebrand.ts (injected into the studio bundle):

- Clicks the Compositions tab's own close control **once** — dockview
  removes the panel properly so state, persisted layout and the menu
  checkbox all stay in sync. A manual re-enable via the menu is detected
  on next load and never overridden again (`fc-comp-off`/`fc-comp-respect`
  localStorage flags).
- Clones a real `menuitemcheckbox` row into any panels menu containing
  "Reset layout" (both the left-strip "…" menu and the header Window
  menu), labels it "Annotate", and wires it to the annotate overlay via
  new exposed hooks `window.__fcAnnotateToggle` / `__fcAnnotateIsOpen`.
  Check state mirrors the overlay on each open.

Net default left strip: **Assets** (first, active), Code, Catalog,
Annotate clone-tab. Compositions re-openable from the same menu.

**Note on saved layouts:** the dockview layout itself persists in
`hf-studio-ui-preferences`; our close-once approach handles that — it
edits the live dock instead of fighting the serializer.

### Workspace "how it works" card (2026-11-14, rev `donova-studio-00028-jmk`)

The desktop workspace went hero → folders with no explanation of the
edit loop. `desktopPage` now renders a numbered walkthrough between the
folders and Project files: drop clips → open Studio → describe the edit
in the chat pill → preview + tweak → export lands in Donova Videos with
a real save dialog; closing note points Inspo/style.md at style memory.

### Workspace uploads bypass the 32MiB edge limit (2026-11-14, rev `donova-studio-00029-dvd`)

**Bug:** any clip >32MiB failed to upload silently. Cloud Run rejects
inbound request bodies >32MiB at the Google Frontend (before the
container) — nothing logged, and the page's `fetch().then()` ignored
`r.ok` so the failure was invisible. Verified: 40MB PUT → 413 at the LB.

**Fix:** direct-to-GCS resumable uploads.

- `POST /api/desktop/upload-url` → `file.createResumableUpload()` returns
  a session URI (no signing/IAM needed); the browser PUTs the file
  straight to `storage.googleapis.com` — same 40MB file now lands in ~4s.
- `POST /api/desktop/finalize` pulls the object into `inst.dir` when the
  instance is booted so a running Studio sees it; best-effort (GCS is
  the source of truth — the file list is already correct).
- Bucket CORS on `donova-renders-donova-514500`: PUT/GET/HEAD/OPTIONS
  allowed from both studio origins.
- Client: XHR drives the PUT with a real progress %, error paths surface
  actual messages in the folder label (`r.ok` now checked everywhere),
  and a drop carrying no files (link/app item) explains itself instead
  of no-oping.
- Old `/api/desktop/upload` POST kept for compat; `knownPaths` delete
  propagation is unaffected — GCS-only objects were never local so the
  reap loop can't touch them.

### "New edit" — archive, don't destroy (2026-11-14, rev `donova-studio-00030-kmn`)

There was no project model beyond "one index.html" — starting over meant
asking the agent to rewrite it and losing the old composition. Now a
deterministic archive flow (option 1 + button, per user pick):

- `POST /api/desktop/new-edit` copies the current composition to
  `edits/edit-<utc-ts>.html` (deduped), preferring the local instance
  copy when present so un-pushed edits survive; then writes
  `BLANK_COMPOSITION` to index.html on both sides.
- Sidecar `POST /new-edit` does the same on the local tree for
  `donova studio`; refused in cloud mode (sync tick would race it).
- Buttons: injected `fc-newedit-pill` in the Studio header (left of the
  auto pill / Export; confirm → POST → `location.reload()`), and
  "+ New edit" on the workspace hero (archives then opens Studio).
- Untouched: footage folders, `renders/`, `style.md`, `.donova/turns.json`
  (the agent still remembers the previous edit's conversation).
- Verified live: 401 unauth, pill marker + endpoint in served bundle,
  workspace button rendered. Endpoint not invoked live — it would
  archive the user's real composition; the flow is non-destructive by
  construction and the user's first click is the proof.


## -9e. Pre-launch audit: four agent blockers fixed (2026-11-13)

Audit before trial launch found and fixed:
- **style.md never reached the model** — ctx.styleMd was loaded (GCS/disk)
  but the prompt only said "present (N chars)". Now inlined (8KB cap) so the
  agent applies the style bible to every edit and preserves it on write_file.
  Prompt clarified: durable prefs carry forward, one-off overrides excluded.
- **first-chat crash for Studio users** — studio-service seeded
  `.donova/turns.json` as `{turns:[]}` vs Agent.load's `Turn[]` → `.push`
  TypeError → 500. load() now normalizes both shapes; seed writes `[]`.
- **cloud agent had no memory** — buildAgent per chat reset this.history;
  load() now replays last 10 turns (message+reply) into context.
- **no chat surface** — hosted Studio runs upstream `hyperframes preview`
  (no chat panel; upstream agent is HeyGen-OAuth-gated and inert), and the
  dashboard had no chat UI. `ChatPanel` added to the dashboard: send/undo/
  history feed/chatRemaining — hits the fully-wired /api/chat.

**Architecture reality check:** `donova studio` locally AND hosted Studio run
the upstream `hyperframes preview` server+UI — our `packages/studio-server`
only serves `donova studio --local`. The upstream agent path is HeyGen-auth-
gated → inert for our users. The user-facing "agent pulls my style.md" flow is
the external-agent path (AI tool + CLI + skills reading style.md from disk);
the built-in cloud agent now matches it via inlined styleMd.

**Audit-verified safe:** signed account cookie + live GCS entitlement check on
every route; path traversal guards (safeRel/localPath/worker); Stripe webhook
signature; trial rate-limit (5/IP/day); upload 256MB cap; worker IAM-locked;
secrets never in repo. **Open follow-ups:** renders/start accepts arbitrary
bundleKey/bundleUrl (cost-abuse vector — rate-limit it); no max-instances or
session affinity on web (per-container mirrors diverge — fine at trial scale);
chat usage counters are best-effort across containers; past_due Stripe
accounts keep access during card retry.

## -9d. Billing: Helcim → Stripe (2026-11-13)

Billing now runs on Stripe (live mode). `HelcimModal`+`lib/helcim.ts`+
`/api/billing/initialize` deleted; `CheckoutModal` POSTs `/api/billing/checkout`
→ Stripe-hosted Checkout → success redirects to `GET /api/billing/confirm?
session_id=…` which verifies the session server-side, records the subscriber,
sets cookies, redirects to `/dashboard`. `POST /api/billing/webhook` is the
durable lifecycle record: `checkout.session.completed` activates,
`customer.subscription.{updated,deleted}` re-activates/deactivates
(past_due keeps access), `invoice.payment_failed` logs. Subscriber record
gained `provider/stripeCustomerId/stripeSubscriptionId/canceledAt`; activation
merges over the existing record so usage counters survive re-subscribe.
Stripe-side (live): product `prod_VcfWe1xAGRAQmm`, price
`price_1UbQBgL5oy3FSbVszyQ3tpD3` ($11/mo), webhook `we_1UbQBoL5oy3FSbVsitHT9VyF`.
Secrets `stripe-secret-key` + `stripe-webhook-secret` are in Secret Manager;
deploy.sh mounts them + sets `STRIPE_PRICE_ID`. Live smoke-tested: real
checkout session created/retrieved/expired via SDK 23.1.0. **Not yet deployed**
— webhook + secrets are already live and waiting.

## -9c. Cloud agent: full run-cmd via render-worker /run (2026-11-13)

The "not available in Donova Cloud yet" gap is closed: `cloudRunCmd`
(`apps/web/lib/agent.ts`) now routes `probe`, `transcribe`, `cuts`, `captions`,
`scaffold`, `add`, `snapshot`, and `render` to a new `POST /run` on the render
worker (`apps/render-worker/src/{run,server,storage}.ts`), which has ffmpeg +
Chrome + all packages in-image. Flow: web reads the project from GCS, invokes
`/run` via a Google-signed OIDC `Authorization` header (`lib/storage.ts
triggerCloudRun`), worker pulls only the needed files, runs the verb against
package-level functions (no CLI shell-out), pushes `filesWritten` back, web
re-materializes them into the mirror + flushes agent `changed` files to GCS
first (`runCmd` gained a `ctx.changed` param). `check`/`timeline` stay
in-process on web; `render` enqueues a real Job. `captions` core moved to a
pure `generateCaptionsHtml` in `@donova/media` (CLI is now a thin fs wrapper).
Parakeet is prefetched in the worker Dockerfile. **Auth note:** `/run` uses
the same OIDC-invoker model as `/render` — verify `--no-allow-unauthenticated`
is set on `donova-render-worker` before launch (worker has no own auth layer).
Worker route + end-to-end cloud chat path are untested in prod; unit-verified
locally (captions core, builds, typecheck).

## -9. Real Studio as a Cloud Run service (apps/studio-service)

The hosted Studio now runs the SAME code as local `donova studio`, **per user**: the
supervisor (`apps/studio-service/src/index.ts`) derives `uid = u-<sha256(email)[:12]>`
from the session cookie, materializes `projects/<uid>/` from GCS into
`/tmp/donova-users/<uid>` (owner → legacy `projects/default/`), spawns
`hyperframes preview <dir> --port <3100+n>` directly in the foreground (no upstream
daemon — its 10s readiness window was too short for Cloud Run), and runs a per-user
sync loop pushing changed files back to the user's own GCS prefix. `GET /studio`
returns a "warming up" page while a user's instance cold-boots (~60-90s first time).
Web-side upload/render routes scope to the same prefix via `lib/subscribers.ts
userPrefix()` reading the `donova_email` cookie (set by /api/trial + billing/confirm).

- Service `donova-studio`, image `donova-images/studio-service`, CPU 4 / 8Gi /
  timeout 3600 / **max-instances=1** / min-instances=1. Per-user instances are
  evicted when idle >20min or >8 concurrent users (LRU; eviction pushes to GCS
  first and wipes the /tmp root).
- `--allow-unauthenticated` at the infra level, but the service enforces an HMAC
  session gate itself: `?t=<token>` (web-issued, 5min TTL) or `__donova_session`
  cookie (30d); everything else → 401 gate page. `STUDIO_GATE_SECRET` env on both
  services; the raw secret doubles as an owner master token.
- Web side: `/api/studio-link` checks `subscribers/<sha256(email)>.json` in GCS
  (written by `/api/billing/confirm` on Helcim checkout; `DONOVA_OWNER_EMAILS`
  allowlist bypasses) then returns the signed Studio URL. Navbar + dashboard
  "Open Studio" buttons go through it — non-subscribers get the subscribe flow.
- **Security lockdown (2026-11-13, verified live)**: every legacy `/api/*`
  project route + `/project/*` now requires the signed `donova_account` cookie
  (HMAC `base64url(email|exp).sig` — lib/auth.ts) AND an active subscriber
  record, and all project ops resolve inside `userPrefix(email)`. The unsigned
  `donova_email` cookie is display-only. `/api/billing/confirm` verifies the
  checkoutToken against Helcim server-side (fails closed without
  HELCIM_API_TOKEN). `/api/trial` is IP-rate-limited (5/day, GCS counter).
  Uploads cap at 256MB (web) / 2GB (studio desktop). `public/studio` + the
  `/studio` rewrite are gone. Admin endpoint takes `x-admin-key` header only
  (timing-safe compare). Studio gate fails closed when the secret is missing.
  `pushChanges` no longer drops >512MB files and skips overlapping runs.
- **Secrets in Secret Manager**: `studio-gate-secret` (rotated 2026-11-13 —
  v2; the old leaked value is dead everywhere), `helcim-api-token` (referenced
  when it exists). Both deploy scripts use `--set-secrets`; rotate with
  `gcloud secrets versions add` + `--update-secrets=name:version`.
- Verified: anonymous → 401 gate page on every path incl. /api/*; master token →
  302 + session cookie → full SPA/API; fake email → 403 not-subscribed.
- **Delete propagation (2026-11-13)**: `pushChanges` now diffs `inst.knownPaths`
  (seeded at materialize, updated each tick) against the live walk — paths gone
  locally are deleted under the user's GCS prefix, so deletes survive eviction/
  redeploy. Guard: deletes skip entirely when the local walk is empty, so a wiped
  `/tmp` can never mass-delete GCS. Seed folders (`inspo`/`raw footage`/`donova
  videos`) still re-`.keep` at boot by design; their *contents* stay deleted.
- **Verified multi-user isolation (2026-11-13)**: trial user → fresh seeded
  `projects/u-*/` tree + own preview on own port; upload lands only in their
  prefix; owner's `projects/default/` list shows no cross-user files; both
  users' studios run side-by-side on one container.
- **Workspace desktop**: authed `GET /` serves a folder-home screen (inspo ·
  raw footage · donova videos cards, live file lists, upload dropzone →
  `POST /api/desktop/upload`, signed-download links → `/api/desktop/download`).
  Studio SPA moved to `/studio` (proxy strips the prefix); the donova wordmark
  click → `/` via a snippet injected into proxied HTML at the proxy layer —
  the shared rebrand patcher + local `donova studio` are untouched.
  `GET /#project/...` deep links forward to `/studio#...` via desktop JS.
- **Folder parity**: uploads (web `/api/upload` + desktop) land in
  `raw footage/`; renders (`lib/jobs.ts` outputKey) land in
  `donova videos/` inside the project prefix; all three folders get `.keep`
  seeded at boot so they exist from day one.
- URL: `https://donova-studio-712078215622.us-central1.run.app`.
- Web links (`Navbar`, `/dashboard`) resolve `lib/studioUrl.ts` → `NEXT_PUBLIC_STUDIO_URL`
  with the deployed URL baked as default.
- Because the service has chrome+ffmpeg, the SPA's OWN render/export/check routes
  work natively — no worker hop needed for Studio exports.
- Verified live: SPA title "Donova Studio" (rebrand patcher ran), `/api/projects`,
  `/api/environment/ffmpeg` `{"ok":true}`, `/api/fonts`, SPA assets, SSE `/api/events`,
  and the 8s GCS write-back loop (verified locally; same code path in service).
- Known limits: `/tmp` is RAM so project media budget ≈ container mem;
  SPA features that need HeyGen auth stay inert exactly like local.

The §-8 routes/UI (`/studio` page + `/api/*` in apps/web) still exist and work as the
legacy lightweight editor; the primary Studio link now goes to the service.

## -8. Hosted Studio on Google Cloud Run (single-project, pre-auth)

`apps/web` embeds the legacy single-file Studio UI
(`packages/studio-server/src/ui/index.html` → `public/studio/index.html`, served at
`/studio`) backed by a GCS project store — NOT the upstream multi-project React SPA.
Superseded for primary use by §-9; kept because the chat-panel agent surface still
lives only in this UI.

- Project state: GCS `projects/default/` prefix in `donova-renders-<project>` bucket;
  `lib/project.ts` is the store (read/write/list/stream + `/tmp` mirror for the agent).
  Seeded on first access (index.html + style.md + donova.json, 1080x1920).
- All local Studio endpoints exist as Next routes: `/api/spec|file|mutation|lint|files|
  style|assets|chat|undo|turns|render`, `/project/*` (runtime-injected HTML + range
  streaming), `/__fc-runtime.js` + `/__fc-gsap.js` (synced to public/ by
  `scripts/sync-runtime.mjs` at build — dot-names can't be route segments).
- The agent is the same `Agent` class via new `@donova/studio-server/agent` subpath
  export; `lib/agent.ts` materializes text files to /tmp per op, then pushes changed
  files + `.donova/turns.json` back to GCS. `runCmd` cloud subset: `check` (in-process
  lint), `render`/`renderDraft` (worker), `timeline`; media commands reply "not
  available in Donova Cloud yet". `ANTHROPIC_API_KEY` env enables the real tool loop.
- Renders: `POST /api/render` → worker `POST /render` with `projectPrefix` (new worker
  ingest mode — no zip); job status in-memory + `renders/jobs/<id>.json` GCS record;
  download URLs are signed (bucket is private — plain GCS URLs 403).
- Uploads land in `projects/default/media/` so they're immediately usable as
  `media/<name>` in compositions.
- Known gaps: no auth/users yet (single shared project — the URL IS the gate);
  concurrent edits across instances can race (mutex only covers one instance); media
  CLI commands need a worker-side implementation to work in-cloud.

## -7b. Cutout webms need dense keyframes (live-preview seekability)

`do remove-background` encoded VP9-alpha with libvpx's default GOP → the 119-frame
cutout had **one keyframe**. Chrome can't seek mid-GOP on VP9-alpha: `currentTime`
updates but the decoder shows frame 0 frozen → Studio preview rendered a ghost
person (cutout stuck at its first frame while the base video played on). Both
render paths were immune — ffmpeg decodes sequentially, never needs keyframes.
Fix: `-g 15` in `bgRemoval.ts` → ~8 keyframes per 4s cutout. Verified in real
Chrome preview: cutout seeks + tracks the zoom, text-behind-person reads.

Two related traps, both bitten once: (a) `ffmpeg -i a.webm -c:v libvpx-vp9 out.webm`
**drops alpha** — the native vp9 decoder ignores BlockAdditional; must pass
`-c:v libvpx-vp9` on the INPUT side to keep it. (b) U²-Net masks on camouflage
backgrounds are ragged (bush-texture halo in person shape) — mostly invisible in
this compositing scheme because kept pixels duplicate the identical base frame;
errors only show as a soft halo against layers *behind* the person (e.g. text).

## -7. Alpha-video frame extraction (person cutouts render over text/footage)

WebM/MOV sources whose alpha rides a stream tag (`alpha_mode=1`, BlockAdditional data)
rather than `pix_fmt` were misclassified as opaque → extracted JPG → the overlay painted
the full scene over everything beneath it (hid text layer entirely in the flower-catch
render while preview stayed correct). Fix: `probe()` now surfaces `alphaMode` from the
stream tag and `sourceHasAlpha` checks it → `libvpx-vp9` decode + PNG extraction.
Verified: `flower-him.webm` cutout renders as a transparent person layer; coral text
behind him occludes correctly in the final MP4 (t=8.7: his head masks mid-text).
Watch out: alpha footage → PNG extraction is ~10x the bytes of JPG (116 frames ≈ 1.5GB).

Gotcha for agent/scaffold hygiene: a stray `do init`/`scaffold` run in the repo root
will overwrite this repo's own AGENTS.md with the project template (happened once —
restored from HEAD). Always pass `--dir` explicitly.

## -6. Speed ramps + video transforms — verified end-to-end (flower-catch test)

First real vibe-edit (`/Users/dyl/hf-test/@dylwill/projects/flower-catch`): 3-segment razor +
retime + zoom. `data-speed="0.7"` on the catch segment + `data-do-motion` scale keyframes on each
`video.clip`. Rendered 2160x3840@30 — punch-in lands on the catch, slowed audio syncs.

Three latent bugs found + fixed along the way:

- `runtime/src/browser.ts` `collectMedia`/`seekMedia`: `data-media-start` was never applied to
  element seeks — segmented clips previewed from the head. Now `local = mediaStart + elapsed*speed`.
- `runtime/src/browser.ts` `updateVideoFrames`: frame overlays didn't mirror the video's transform,
  so zoom anims were invisible in renders. Wrapper now copies transform + translate/rotate/scale
  longhands + origin per frame (WAAPI `scale` doesn't fold into computed `transform` — mirror each).
- `producer/src/audio.ts`: `atrim` cut `duration` (film) not `duration*speed` (media consumed), so
  slowed audio bled past its slot. Fixed — slowed segments now exactly fill their window.

`data-speed` is now confirmed wired through all three paths: element seek, frame-overlay extraction
(`mediaDur = duration*speed`), and `atempo` audio.

**Preview parity found**: Studio's speed attr is `data-playback-rate` (Studio writes it on retimed
clips). Without it their preview played our slowed segment's media 1:1 then cut back at the next
clip's media-start. All readers now accept `data-speed ?? data-playback-rate` (bidirectional —
HF-retimed clips render correctly under our engine too) and emitters/agents should write both.
Verified in their player iframe: `__player.seek(6.3)` → vid-1 at media 6.0, playbackRate 0.7 — exact
match with render math. Zoom authored as registered `__timelines` GSAP (not `data-do-motion`) so it
seeks in both engines; gsap served from local `assets/gsap.min.js`.

## -5. Studio rebrand (donova) — v3 patcher, de-HeyGen surface pass

`packages/cli/src/rebrand.ts` patches the installed hyperframes Studio bundle on every `do studio`
launch (versioned `donova-rebrand-v3` marker, re-patches when the patcher changes): injects a script
into `dist/studio/index.html` that

- replaces the SVG wordmark (`svg[aria-label="Hyperframes"]` — compiled JSX paths, not text) with a
  styled lowercase **donova** span
- retitles the page to "Donova Studio" and overwrites `favicon.svg` with a "d" mark
- **removes HeyGen surfaces entirely**: the "Open in desktop app" dropdown button, its menu items,
  and the `aria-label="Get the desktop app"` trigger are `remove()`d — not hidden
- rewrites any remaining `HeyGen`/`HyperFrames` rendered text to `Donova` via a TreeWalker text-node
  pass (covers dialogs/toasts/menus rendered later; skips script/style/code/pre)

A MutationObserver re-scrubs added nodes; each added node is checked **itself and** its descendants
(v2 bug: React mounts controls as direct additions — a descendants-only scan misses them). Verified
headlessly at localhost:3005: top bar reads "donova | do-e2e", zero HeyGen text nodes, "Open in
desktop app" absent, Window menu holds only panel toggles, **Export kept** (it's a local render
button, not HeyGen). Why a DOM patcher instead of bundle surgery: the wordmark is minified React JSX,
not a string; the injected script survives any bundle shape and self-heals after package reinstall.
**Still the item-3 stepping stone** — proper vendoring (strip auth/billing/cloud routes server-side,
wire our agent into "Describe a change") supersedes it.

## -4. Feature-parity pass (everything non-gated plugged in)

**Commands — batch 2 delegates** (same `hf.ts` passthrough): `lint`, `info`, `compositions`, `docs`,
`browser`, `clean`, `lambda`, `cloudrun`, `compare-sheet` (HF `compare`). Deprecated-upstream `inspect`
and `validate` deliberately skipped — `gate` covers them. `do clean` verified real (freed 2.3 GB of
HF cache); `lambda`/`cloudrun` expose deploy + `sites create` for renders on the *user's own* AWS/GCP.

**Starter examples** — 9 HyperFrames example projects ported to `registry/examples/`:
`product-promo`, `swiss-grid`, `vignelli`, `warm-grain`, `kinetic-type`, `nyt-graph`, `path-traced-3d`,
`play-mode`, `decision-tree`. `do init --template <name>` copies one + derives `donova.json` from
its `registry-item.json` dimensions. Catalog lists them as `type: "example"` (472 items total).
Verified: `do init do-promo --template product-promo` → `hyperframes lint` 0/0.

**Skills — batch 2** (5 more, refs remapped `hyperframes`→`donova`, gated commands kept marked):
`changelog-video` (VO step now `do tts` + `do transcribe` word-align; gate call → `do gate
--caption-zone`), `slideshow` (keeps `hyperframes-slideshow+json` contract strings — `do present` and
the upstream player element detect those literal names), `remotion-to-donova` (renamed),
`figma`, `media-use` (flipped to **local-first**: `do tts`/`remove-background`/`media-treatment` are
the default column; HeyGen sign-in optional). Still skipped (Pro-gated): `reverse-any-video`,
`style-sampling`.

**SDK** — `@hyperframes/sdk@0.9.20` added as a dep and re-exported via `donova/cli` `sdk.ts`:
`openComposition(html)` gives find/patch/timing/history ops on our files natively (verified: 319
element handles on do-e2e). Agents can now do structured composition edits, not just CLI calls.

**Adapters — audited, not needed for parity:** every ported block wraps its engine (three.js, d3,
lottie, shaders) inside a registered `__timelines` GSAP timeline, so our universal timeline seek
covers all 463 items without per-engine adapters.

**Remaining real gaps (all need item-3+ work, not plugs):**
- Studio vendoring/rebrand + wiring OUR agent into Studio's mutation routes (item 3)
- `<hyperframes-slideshow>` element — lives in `@hyperframes/player`'s slideshow export; our
  `donova-player` doesn't ship a slideshow wrapper yet (decks still run via `do present`)
- `share`/hosted publish — HeyGen backend; ours would need our own share infra
- HeyGen `cloud` render — gated; `lambda`/`cloudrun` to user-owned clouds now covers self-hosting
- `media-use` resolve verb — HeyGen catalog/gen needs auth; local-tool column fully works

## -3. HyperFrames command delegates (plugged like Studio)

Since conformance makes our projects valid HF projects, their *local* CLI commands run on our projects
natively. `packages/cli/src/hf.ts` provides `runHyperframes()` (bin resolve, telemetry off, exit-code
preservation); each command is a citty delegate forwarding `rawArgs` verbatim:

| `do` command | → `hyperframes` | Gives us |
|---|---|---|
| `gate` | `check` | Deep gate: lint + runtime + layout + contrast + audio + readability |
| `capture` | `capture` | Website → captured footage (product-launch workflow) |
| `beats` | `beats` | Beat detection → `beats/*.json` |
| `audio` | `audio` | Onsets/hits/loudness/silence per clip in film time |
| `media-treatment` | `media-treatment` | Deterministic footage looks (`--selector` required) |
| `normalize-audio` | `normalize-audio` | LUFS-matching between clips |
| `diff` | `diff` | Score render vs source frame-by-frame |
| `measure` | `measure` | Video measurement (probe/cuts/events/frames/… subcommands) |
| `history` | `history` | Recorded project changes + undo/restore |
| `keyframes` | `keyframes` | Keyframe inspection + onion-shot diagnostics |
| `grade-compare` | `grade-compare` | Labeled grade comparison PNG |
| `benchmark` | `benchmark` | Render speed/size sweeps |
| `present` | `present` | Slideshow presenter mode |
| `timeline --lanes` | `timeline` | Visual lane timeline (bare `do timeline` stays our JSON clip list) |

**Verified live on /tmp/do-e2e:** `gate` (Check passed, catches `line_unread` readability warnings),
`audio` (per-clip onsets/hits/LUFS/voice-classification), `beats`, `history`, `keyframes`, `timeline
--lanes`, `present`, `benchmark`; `diff`/`measure`/`capture`/`media-treatment`/`normalize-audio`/
`grade-compare` verified via usage-error forwarding. **Caveat:** citty intercepts `do <cmd> --help` —
upstream flag help lives at `hyperframes <cmd> --help` (bin is a dep, `npx hyperframes` works).

**Skipped:** `inspect` (deprecated upstream → `gate` covers it), `cloud`/`publish`/`open`/`catch-up`/
`reverse`/`templates`/`billing`/`auth`/`telemetry` (HeyGen-hosted or Pro-gated), `transcribe`/`tts`/
`remove-background`/`snapshot`/`compare`/`init`/`add`/`catalog`/`render` (ours equal or better).

**Not yet plugged:** `lambda`/`cloudrun` (deploy to *our own* AWS/GCP — not HeyGen-gated, belongs with
§-4 render infra); `@hyperframes/player` web component + `@hyperframes/shader-transitions` (npm deps
for later embed/transition work).

**Caption readability fix folded in:** `captions.ts` now extends each caption's hold toward
`0.5s + 0.3s/word` (HF `line_unread` rule), capped at the next caption's start so holds extend into
speech gaps without overlapping. Fast-speech sequences can't physically hold — `do gate` still warns
there; `--mode phrase` is the real fix for dense delivery.

## -2. HyperFrames conformance + registry/skills port

**Donova projects are now valid HyperFrames projects.** `hyperframes lint` reports **0 errors, 0
warnings** on fresh `init` and `--footage` scaffold output; the migrated do-e2e project reports 0 errors
and 1 opinionated warning (`composition_file_too_large` — inlined word captions).

**Format conformance (item 1 of the port plan):**
- Roots emit `id="root"`, `data-composition-id`, `data-width`/`data-height`, `data-fps`, plus
  `data-no-timeline` (we animate via `data-do-motion`, not a registered GSAP timeline — the flag saves
  their producer a 45s poll).
- `data-composition-src` hosts carry `data-composition-id` + `id` (see `add` hint, agent auto-wire).
- Scaffolded `<video>`s are hoisted `.clip` elements with own `id="vid-N"`, `data-start`, `data-duration`,
  `data-media-start` — matching HF's media model. Their Studio timeline now shows named `Vid 0..N` lanes.
- All timed elements get stable `id`s (caption clips: `cap-N`; block internals: `<name>-1`) — required for
  Studio's canvas edit targets.
- Our 14 own blocks were wrapped in doc shells with root composition attrs.

**Runtime compat (`packages/runtime/src/browser.ts`):**
- Imported sub-compositions: `<style>`/`<link>` imported + **scoped to the host** (prefixed selectors;
  html/body width/height stripped), `<script>`s execute, `window.__timelines` registrations are
  *namespaced per host* and seeked at **local** time (host-relative), not global time.
- Verified: a real HF block (`lt-dark-card` — standalone HTML + CDN GSAP + `__timelines`) renders and
  animates under our engine and inside a real `do render` mp4.
- `renderSeek` seeks `scopedTimelines` at `t - clipStart`; `__playerReady` is declared only after
  `renderSeek(0)` completes.
- Timed-element visibility now restores the *authored* `display` value (flex/grid survive), not `""`.
- Video frame overlays insert into the video's own DOM slot matching its box (fixes overlays painting
  over everything after videos were hoisted to root children).
- `/__fc-gsap.js` serves vendored `gsap.min.js` (runtime + studio-server routes) so authored GSAP in
  compositions works offline; compositions that use GSAP must register `__timelines["id"]`.

**Registry port (item 2):** 213 blocks + 235 components + 15 SFX = **463 catalog items** in
`registry/catalog.json`. HyperFrames `registry-item.json` metadata normalized to our `block.json`/
catalog conventions (`variables` → `vars`). Multi-file blocks keep relative asset/lib paths inside
`compositions/<name>/`. HeyGen/avatar-branded entries excluded (actual avatar-gen + HeyGen UI only —
mock-UI avatars in e.g. comment/thread blocks kept). Apache-2.0 attribution in `registry/NOTICE.md` +
`registry/LICENSE-hyperframes.txt`.

**Skills port:** `captions-overlay`, `cut-the-curve`, `motion-doctrine`, `oversized-cursor`, `seam-craft`
in `skills/` (HeyGen-Pro-gated `reverse-any-video`/`style-sampling` skipped — no proprietary backend).
`copyPrompt.ts` + `donova-core`/`donova-registry` skills document the host/root contract.

**Emitter touchpoints:** `init.ts`, `scaffold.ts` (media), `captions.ts` (ids + root-duration clamp),
`cli.ts` add hint, `agent.ts` auto-wire.

**Not yet done:** verify *every* one of the 463 items renders (spot-checked `lt-dark-card` + our 14);
components' install targets vs blocks not exhaustively tested; Studio still shows HeyGen branding
(§-3 vendoring is next).

## -1. HyperFrames Studio integration (architecture decision)

**Decision: Donova adopts HyperFrames Studio (Apache-2.0) as the editing surface** instead of growing
`@donova/studio-server`'s ~300-line UI. Donova keeps the differentiators: the footage-first
pipeline (`transcribe → cuts → scaffold → captions → render`), the in-app agent concept, `--prompt` vocab
stitching, Parakeet engine, clean defaults, self-owned SFX.

**Verified 2026-11-07:** `hyperframes preview /tmp/do-e2e` boots on an Donova project with zero
adaptation — preview renders footage+captions, timeline shows thumbnails/waveforms, playback+seek+caption
sync all work headlessly. Their project contract only requires `index.html`; our attrs are already compatible.

**What was plugged in:** `hyperframes@0.9.20` is now a dep of `@donova/cli`.
`donova studio [dir]` → delegates to `hyperframes preview --background` (telemetry off via
`HYPERFRAMES_NO_TELEMETRY=1` + `DO_NOT_TRACK=1`). Flags: `--port`, `--stop`, `--no-open`, `--local` (legacy
studio). Files: `packages/cli/src/studio.ts`, `cli.ts` studioCmd.

**Format deltas — all resolved in §-2** (`hyperframes lint` now reports 0 errors on our projects).

**Not wired yet (HeyGen-coupled, needs shims/strip later):** their in-Studio agent ("Describe a change"),
Export button, desktop-app handoff, Capture panel, auth/billing surfaces. Telemetry is env-disabled when
spawned through `donova studio`.

**License notes:** HyperFrames is Apache-2.0 (verified in source + package.json). Vendoring/forking later is
legal with NOTICE preservation. Their Studio UI shows HeyGen branding until we vendor+rebrand.

The original plan (`00`–`16`) describes a from-scratch build. A first working version
was built quickly (≈ 4.2k lines of TS) and **partially** covers M0–M6. Most tasks in
`16-BUILD-ORDER.md` are *not* ticked because their full acceptance criteria (CI,
golden harness, full lint set, etc.) were never met. Treat existing code as a working
foundation to harden, not as finished tasks.

**Priority now:** the MV track in `17-VIBE-EDIT.md` / `16-BUILD-ORDER.md`.

## 0. State after the 2026-11-07 fix pass

**All P0s fixed and verified. Most P1s fixed.** Gates: `pnpm build` 9/9,
`pnpm typecheck` 16/16, `pnpm lint` clean, `pnpm test` 17/17, `pnpm test:golden` 2/2.

### P0 fixes — verified
1. **Studio preview**: project now served same-origin at `/project/*` by the studio server with
   `<script src="/__fc-runtime.js">` injected into served HTML. Verified: iframe boots the runtime
   (`__playerReady`/`__fc` true under headless chrome). Files: `server.ts` (+`/project` proxy,
   `/__fc-runtime.js` route, `getRuntimeSource` import), `studio-server/package.json` (+runtime dep).
2. **`data-do-motion` timing**: anim `t` is now relative to `el.closest("[data-start]")`
   (`runtime/src/browser.ts` `buildMotionAnims`). Verified: stat-card at 19.5–22.5s renders "41.8s /
   clean cuts / dead air removed" in a 20.6s snapshot; caption pops play at their clip.
3. **Rotated footage**: `probe` returns `rotation` (display-matrix/tags); `init`/`scaffold` swap w/h
   for ±90/±270; scaffold video CSS is now `inset:0; width/height:100%; object-fit:cover`.
   Verified: snapshots of the −90° iPhone clip are correctly framed, not stretched.
4. **Alpha capture**: `CaptureOpts.alpha` → CDP `setDefaultBackgroundColorOverride` rgba(0,0,0,0) +
   `omitBackground` on screenshots; plumbed `render → renderVideoOnly/parallel → CaptureSession`.
5. **MOV**: temp video uses `.mov` for prores; encoder profile `standard`/`4444`, pix_fmt
   `yuva444p10le`/`yuv422p10le`. Verified: `render --format mov --alpha` → prores `yuva444p12le` MP4→MOV.
   (ffmpeg reports `yuva444p12le` — encoder requests 10le and ffmpeg picks the closest 4444 alpha fmt;
   result is a valid alpha ProRes.)
6. **`compare`**: parses stderr on success too — identical files → `average:inf` → psnr null-in-JSON is
   *correct* (Infinity isn't JSON); different files return real dB.
7. **MCP**: `donova_check`/`donova_snapshot` signatures fixed; server exits on stdin EOF.
   Verified: tools/call check + snapshot return results over stdio.
8. **Agent write guard**: `write_file` refuses `assets/`, `media/`, and media extensions.

### P1 fixes — verified
- `captions` idempotent: BEGIN/END markers; regenerate strips the previous block (155→155 not 310).
- `catalog` command added (`--type`, `--json`).
- `--quality draft` implies scale 0.5; `--range` end > duration hard-fails with a clear error.
- `eval` audio rule reads `hasAudio` (verified "audio stream present"); eval render uses scale 0.5.
- `add` after-install: agent wires a reference `.clip` into index.html; replies now summarize run
  results (`(check: ok=true, errors=0, warnings=16)` style).
- Anthropic provider: real tool loop (≤8 rounds, tool_result feedback); rules fallback unchanged.
- `undo`: undoes the last turn *with changes*; deletes created files, restores modified ones.
- File server answers `/favicon.ico` with 204 (no more check noise).
- `snapshot` runs `prepareVideoFrames` when the comp has `<video>` (was black frames before).
- `remove-background`: mask upsample forced to 1 channel (`extractChannel(0)`) — stripes gone;
  3× min-filter erosion at 320² tightens U²-Net's loose silhouette; verified working cutout.
- `tts say` reads text via `-f file` (leading-`--` text can't be parsed as flags).
- Audio mix ends with `alimiter=limit=0.95`.
- h264 encoder adds `-vf format=yuv420p` for non-alpha (was yuvj420p full-range mislabel).
- Render cleans up: video-only tmp, `render-*` work dirs, audio-mix.aac (keeps frames/video-map cache).
- Registry: `block.json` `vars` regenerated from actual `--do-*`/`data-do-var` usage (dead vars
  removed, missing declared); `caption-strip` got `top:auto` (was stretched by `.clip{inset:0}` CSS).

### Still open (deferred, not blocking)
- **U²-Net edge slack**: cutout keeps a ~20–60px background halo on plain-wall shots — model
  resolution limit, not plumbing. Plan's answer is the MODNet eval (MV8 noted in 17-VIBE-EDIT).
- **Anthropic chat path untested** — no `ANTHROPIC_API_KEY` on this machine; the loop is implemented
  but needs a live key to verify.
- **Studio timeline lanes**: clips still render one-per-row (no lane packing). Cosmetic.
- **`clip-past-duration` warnings** (16 on do-e2e): some generated caption clips extend ~0.5s past
  the 41.84s plan duration. Harmless but should be clamped in `captions`.
- **Block defaults are centered**: stat/card blocks cover the face at default position. Agents/users
  should position them; consider a `--do-y` offset convention later.
- **Sub-comp scaling semantics**: inner `data-do-motion` times scale to the host clip duration — by
  design, but document it in block authoring notes.
- **`donova check` warnings** don't distinguish block-sourced vs user clips in messages.
- **Error codes**: most non-validation failures still return `E_INTERNAL` (unknown block, tts
  provider, missing file). citty's missing-positional-arg error bypasses `--json` (prints help text).
- **Missing `data-composition-src` targets** surface only as a browser 404 in `check`; no static
  fs-existence lint rule yet.
- **`remove-background` video path** is untested (image path verified); the Studio
  "Remove background" inspector button (MV8) is not built; `edge`/`kokoro` TTS providers are stubs.
- **`eval` draft render** writes `eval-render.mp4` at the project root instead of `.donova/`.
- **No `clean` command** for `.donova/frames` cache (~hundreds of MB on real footage).

### Verified working (carried over)
- Real footage E2E on `IMG_4063.MOV` (rotated −90°, 47.8s): `init --footage` → `transcribe` (155 words)
  → `cuts` (6 segs, 5.96s removed) → `scaffold` 1080×1920 → `add stat-card/sfx-impact` → `captions`
  (155) → `check` (0 errors) → `render --workers auto`: **1255 frames, 41.8s, h264+aac in 47s**.
- `doctor`, `style`, `skills update`, `copy-prompt`, `add`, `catalog`, `probe`, `timeline`, `check`,
  `snapshot` (+contact-sheet, video overlays), `render` mp4/webm/mov/gif/`--range`/`--draft`/`--workers`/`--alpha`,
  `tts --provider say`, `eval` (score .875, pass), `mcp` initialize/tools/calls, `remove-background` image.
- Studio server: `/api/spec|assets|lint|style|turns|chat|undo|render` + same-origin `/project/*` proxy.
- 16 blocks: `check` clean, no runtime errors, no Date/random/setInterval.
- 15 self-generated SFX install under `media/sfx/`; `add sfx-*` prints an `<audio>` usage hint.

### Original issue log (historical — superseded by the list above)
The earlier write-up of each bug remains below for context; items marked fixed are verified.
   `2`/`standard` or `3`/`hq`; 4444 = `4`), and `yuva444p12le` unsupported → `yuva444p10le`.
6. **`compare` never returns a PSNR** (always `psnr: null`, even vs a testsrc video). ffmpeg exits 0,
   so the parse in the `catch` never runs and it returns `Infinity` (JSON → null). Parse stderr on success.
   File: `packages/cli/src/compare.ts`.
7. **MCP `donova_check` and `donova_snapshot` throw** (`paths[0] must be string`): `mcp.ts`
   calls `checkProject({dir})` and `snapshotTimes({...})`, but the signatures are
   `checkProject(dir, composition?, opts?)` and `snapshotTimes(dir, composition, times, outDir)`. Also
   `donova mcp` never exits on stdin EOF (`await new Promise(() => {})`): add `stdin.on("end", exit)`.
8. **Agent can overwrite raw footage.** `agent.ts` `write_file` only blocks `media/` and `..`, but
   `init --footage` puts footage in `assets/`. Block any path whose extension is video/audio/image
   or that is referenced as a `<video>/<audio>` src; never allow writes to `assets/` raw files.

### P1 — wrong results / bad UX
9. `captions` is not idempotent: a second run appends a second track (duplicate captions).
   Replace the block between the `<!-- generated captions -->` markers (add an end marker).
10. Path conventions disagree: `init --footage` → `assets/`, `transcribe` default out `./transcript.json`,
    but the Studio rules agent hard-codes `media/transcript.json` and picks the *first file under
    `media/`* to transcribe (it transcribed `media/sfx/.../impact.wav`). Pick one layout
    (recommend `assets/` = raw footage, `media/` = generated) and use it in init, CLI defaults,
    `agent.ts` rulesTurn, `copyPrompt.ts`, and skills.
11. Rules agent: `add a lower third` installs the block but does not wire it into `index.html`
    (0 changes → nothing visible); `check it` replies "Running…" but never shows the result. Tool
    output must be summarised into the reply.
12. Anthropic agent path is single-shot (no tool_result round-trip, so the model never sees check/
    snapshot output) and is **untested** (no API key on this machine). Model id `claude-sonnet-4-5`
    is unverified. Implement the tool loop (max N iterations) and test with a key.
13. `undo` pops the last turn even if it changed nothing (then the real edit can't be undone in one
    click) and leaves files the turn created. Undo the last turn *with changes*; delete created files.
14. `eval` audio rule reads `probe.audio.codec`, but `probe` returns `hasAudio` → always "no audio
    stream" (false fail on the E2E project that has AAC). Also eval's "draft" render is full-res and
    serial (92s); pass `scale: 0.5`, `workers: auto`, write to `.donova/`, not the project root.
15. Temp leaks: `*.video-only.tmp.mp4` left next to every output; `.donova/render-<ts>/` worker
    dirs (195 MB on the E2E) never deleted; `.donova/frames` (173 MB) has no `clean` command.
16. Registry blocks:
    - `caption-strip` renders as a full-height dark bar in any project whose CSS has
      `.clip{inset:0}` (scaffold emits exactly that). Blocks must set `top:auto`/explicit box, or
      scaffold should scope its rule to `.clip > video`.
    - Declared vars with no effect: `card.pos`, `progress-bar.pos`, `flash.color` (HTML reads
      `--do-flash`), `flash.dur`, `zoom-transition.from/to/dur` (JSON motion can't read CSS vars),
      `fade-title` uses a dict-shaped `vars` with key `--do-title-color` (schema inconsistent).
    - Many CSS vars used but undeclared (e.g. card has 15) — declare them in `block.json`.
    - Sub-comp time scaling stretches a block to the host's duration (a 0.12s `flash` on a 3s host
      lasts 3s). Make scaling opt-in (`data-scale="fit"`) or document host duration = block duration.
    - New blocks' `block.json` lack `type`/`version`/`files` that the original two have.
17. `donova catalog` is referenced 5× in skills but the command doesn't exist (`Unknown command`).
18. `--quality draft` alone doesn't downscale (only `--draft`); either make draft imply scale 0.5 or
    document. Out-of-range `--range` gives a raw ffmpeg "End of file" error; validate against duration.
19. Errors: most failures return `E_INTERNAL` (unknown block, tts provider). Use specific codes.
    citty's missing-positional error ignores `--json` (prints help text, not the JSON envelope).
20. `snapshot` at early times shows black for `<video>` clips (it doesn't use the extracted frame
    overlays the renderer uses), so agents "looking" at frames get wrong pictures. Reuse video-map.
21. Missing sub-comp file only surfaces as a generic `console.error: 404`; lint should check
    `data-composition-src` targets exist.
22. Output pix_fmt is `yuvj420p` (full-range JPEG) for mp4; encode `yuv420p` + `-color_range tv`
    for player compatibility.
23. Audio peaks at −0.1 dBFS on the E2E (voice + SFX); add a limiter (`alimiter`) at the end of the mix.
24. `remove-background`: verify the video path (only the image path was tested after the fix);
    CoreML logs warnings to stderr; `say` text beginning with `-` is parsed as an option (pass `--`).
    Studio "Remove background" button (MV8) not built. `edge`/`kokoro` TTS providers are stubs.
25. Runtime `loadSubComps` uses `fetch()` at render time (local file server). Acceptable locally,
    but for cloud/Lambda inline sub-comps at compile time instead.

### P2 — hygiene
26. `pnpm typecheck` fails in `@donova/cli`: `captions.ts` `units` typed as `Array<{…}>[]`
    (should be `Array<{…}>`); `mcp.ts` signature errors (#7).
27. `pnpm lint`: 49 errors, all in new MV3–MV10 files (formatting, import order, `!` assertions,
    template literals). `pnpm format` fixes most; replace `!` with guards.
28. Studio timeline puts every clip on its own row (163 rows on the E2E) — needs track lanes
    (`data-track-index`) and a captions lane.
29. No unit tests for any MV code (captions, cuts mapping, sub-comp loader, agent undo, mcp, eval).
    Add vitest specs + a golden test for a block inside a sub-comp at t>0 (would have caught #2).

### Fix applied during this pass
- `packages/media/src/bgRemoval.ts`: mask was multiplied by 255 twice (striped alpha); ImageNet
  mean/std normalisation added; `fps` strict-null guard (unblocked `pnpm build`). The raw model mask
  is now correct. **Still broken (P0):** sharp's `resize` of 1-channel raw input returns **3 channels**
  (confirmed: `info.channels === 3`, 6,220,800 bytes for 1080×1920), so `new Float32Array(big)` is
  3× too long and the alpha comes out as horizontal stripes. Fix in `maskFor`: add
  `.extractChannel(0)` (or `.toColourspace("b-w")`) before `.raw()` on the upsample, then
  re-verify by compositing the PNG over magenta. Then test the video path.

### How it was tested (re-run after fixes)
```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm test:golden
FC="node packages/cli/bin/donova.mjs"
$FC init /tmp/e2e --footage ~/hf-test/@dylwill/raw-footage/IMG_4063.MOV --width 1080 --height 1920 --json
cd /tmp/e2e && $FC transcribe assets/IMG_4063.MOV --json && $FC cuts transcript.json --json \
 && $FC scaffold assets/IMG_4063.MOV --cuts cuts.json --width 1080 --height 1920 --json \
 && $FC add stat-card --json && $FC captions transcript.json --cuts cuts.json --json \
 && $FC check . --json && $FC render . --out final.mp4 --workers auto --json && $FC eval .
# then: place stat-card at t=20 and confirm it is visible at 20.5s in final.mp4;
# open `$FC studio . --port 4141` in a real browser: play, seek, pick, chat, undo.
# alpha: transparent comp → --format webm --alpha → extract frame as rgba → alpha min must be 0.
```

## 1. Packages

| Package | State | Notes |
|---|---|---|
| `contract` | working | `names.ts` (all names), parse5 parser, timecode parsing, timing compiler (`resolveTimeline`, nested sub-comps, `data-clip-absolute`, speed), `planRender`, `data-do-motion` parser/validator, JSON schemas in `schemas/`. Exported parse fn is `parseCompositionHtml` (not `parseComposition`). |
| `runtime` | working | Browser IIFE built to `dist/runtime.global.js`. Root sizing from `data-width/height`, clip visibility + `data-fade-in/out`, GSAP root timeline seek, WAAPI/CSS adapter, `data-do-motion` adapter (split words/chars, stagger, eases), deterministic video frame overlays from `.donova/video-map.json`, media seek, `__renderReady` gate. |
| `engine` | working | ffmpeg locate/run, Chrome Headless Shell ensure/launch, static file server (Range, `.donova/*` misses → 204), capture (beginFrame + screenshot), sacrificial-browser beginFrame probe with cached verdict (`~/.donova/probes/`), streaming encoder (h264/h265/vp9/prores, alpha), chunk encoder, video frame pre-extraction (JPG). |
| `producer` | working | `render()`: parse → plan → extract video frames → serial or parallel capture → audio mix (trim/volume/fades/delay/amix) → mux. Formats: mp4, webm(vp9+opus), mov, gif, png-seq, hls. Parallel = equal contiguous frame ranges, one browser per worker, one retry. |
| `cli` | working | `init`, `check` (`--json`), `preview`, `render` (`--workers --format --quality --fps --alpha`), `studio`, `snapshot --times`, `compare <a> <b>` (PSNR), `add <block>`. No JSON envelope on most commands; progress uses `\r`. |
| `lint` | minimal | Small static rule set + summary/format helpers. Far from the ~100 rules in `07`. |
| `player` | minimal | `<donova-player>` web component. |
| `studio-server` | minimal | Vanilla Node HTTP server + single-file UI `src/ui/index.html` (no Vite/React/dockview). Endpoints: `GET /api/spec`, `GET/PUT /api/file`, `POST /api/mutation` (byte-preserving timing/text edits by timed-element index), `GET /api/lint`, `POST /api/render` + `GET /api/render/:id`, `GET /api/files`, `/studio/*`. UI: canvas iframe, timeline tracks, drag-to-retime, click-to-pick, inspector (start/duration/text), lint panel, render button. |

Other: `registry/` (2 blocks: `fade-title`, `caption-strip`; `catalog.json`),
`skills/donova-core/SKILL.md`, `apps/render-worker/Dockerfile` (untested build),
`fixtures/basic` (GSAP + motion), `fixtures/media` (video + audio), `tests/contract.test.ts`
(17 tests).

## 2. Commands that work

```bash
pnpm install
pnpm build                 # 8/8 packages
pnpm vitest run            # 17 tests (NOTE: `pnpm test` runs turbo; packages have no test scripts)
pnpm lint                  # biome
node packages/cli/bin/donova.mjs check fixtures/media
node packages/cli/bin/donova.mjs render fixtures/basic --out /tmp/out.mp4 [--workers 4]
node packages/cli/bin/donova.mjs snapshot fixtures/basic --times 0,0.5,1 --out snaps
node packages/cli/bin/donova.mjs studio fixtures/media --port 8788   # http://127.0.0.1:8788/studio/
```
`pnpm test:golden` references `vitest.golden.config.ts`, which **does not exist** yet.

## 3. Verified results & hard-won lessons

Verified: basic fixture renders byte-identical twice; video overlay frames land on
exact source timestamps; audio mixed; parallel vs serial ≈ 52 dB PSNR; all output
formats produce valid files; Studio endpoints work.

Lessons (each was a real bug — do not regress):
1. **beginFrame-only Chrome flags must be stripped in screenshot mode.**
   `--enable-begin-frame-control` (+ `--deterministic-mode`,
   `--run-all-compositor-stages-before-draw`, …) makes the compositor wait for frames
   nobody sends: rAF stalls, seeks hang, `Runtime.callFunctionOn timed out`. The probe
   now runs **before** launching the capture browser and picks
   `deterministicFlags()` vs `screenshotModeFlags()` (`engine/src/chrome.ts`).
2. **beginFrame crashes Chrome on this macOS machine** (no display attached —
   `CVDisplayLinkCreateWithCGDisplay failed`, SIGTRAP). Hence the sacrificial-browser
   probe + cached verdict. Local renders use screenshots; Linux/Docker is expected
   to support beginFrame (not yet verified).
3. **Capture as JPEG by default**, PNG only for alpha (HyperFrames default q80).
   PNG screenshots of 1080×1920 are very slow.
4. **Video frames are extracted as JPG** — fast, but **drops alpha** (fix in MV0.2).
5. **Same-src `<video>` segments**: every media element gets a per-tag `mediaIndex`
   (document order); the video map entry carries `index`, and the runtime matches by
   index, not `video[src=…]` (which would bind all segments to the first).
6. **Overlay'd videos are not element-seeked** (`data-do-overlay="1"`); their audio
   comes from the FFmpeg graph. Seeking N hidden MOVs per frame stalled renders.
7. **Only swap overlay frames inside the overlay's time window.**
8. **Render plan shards only at scene cuts** (`class="clip"` or media clips). Timed
   caption `<span>`s used to create ~150 micro-segments → a browser launch per word.
9. **Parallel workers** = equal contiguous frame ranges (HyperFrames
   `distributeFrames`), staggered start, one retry. `encoder.done` has a no-op catch
   so a killed ffmpeg doesn't become an unhandled rejection.
10. **Composition root is sized by the runtime** from `data-width/height`
    (position relative, overflow hidden); otherwise `.clip` boxes follow the viewport.
11. **Paths with spaces**: use `fileURLToPath(new URL(…))`, never `URL.pathname`
    (the repo path is `…/ai video editor`).
12. **Overlays need `* { box-sizing: border-box }`** or padded fixed-width cards
    overflow the frame (shipped in the reference edit v1).
13. FFmpeg 9: no `-vsync`; WebM uses Opus and no `+faststart`.
14. whisper-cli JSON with `-ml 1 -sow`: first entry can be empty; punctuation attached.
15. **Whisper default is `large-v3-turbo`** (sha256-pinned, ~1.6GB) — near-large-v3
    accuracy at ~8× large-v3 speed. `--model small.en` remains for fast passes.
    `--prompt "names, jargon"` both conditions whisper AND drives two
    deterministic post-passes in `transcribe.ts`: `stitchTerms` rejoins
    fragment-spelled terms ("F iver r" → "Fiverr", ≤4 words, <0.5s gaps) and
    `joinContractions` rejoins `'t`-style suffixes. Verified on IMG_4063:
    Fiverr×2 + Zoom casing + all contractions fixed.
16. **Parakeet engine (`--engine auto|parakeet|whisper`, default auto):**
    NVIDIA parakeet-tdt-0.6b-v3 via `sherpa-onnx-node@1.13.8` — better WER than
    large-v3, ~5-10× faster, 26 languages. Model (int8 ONNX, ~670MB) downloads
    to `~/.cache/donova/parakeet/` with size+sha256 pins at a fixed HF
    revision. Decode runs in `sherpaWorker.ts` child process (onnxruntime can
    abort uncatchably); audio is silence-cut into ~30s windows, gaps with
    residual energy get re-decoded + spliced (`parakeet.ts`). Whisper remains
    the fallback for unsupported platforms/languages (`--language` swaps `.en`
    models for multilingual twins). `donova models [install parakeet]`
    lists/prefetches. Verified on IMG_4063: Fiverr correct ×2 with no prompt,
    proper punctuation/casing, zero fragments. Parakeet is CC-BY-4.0 —
    attribution lives in README Notices. Whisper.cpp binary auto-build is NOT
    implemented (HF builds from source; we still require brew install).

Performance reference: 42 s 1080×1920 reel, 1265 frames, screenshot mode, 4 workers
on this Mac → **11 min 18 s**. Basic fixture (640×360, 2 s) → 4.7 s.

## 4. Reference project (local only — not in the repo)

`~/hf-test/@dylwill/projects/do-4063/` — the owner's talking-head clip edited with this
codebase into a 9:16 reel:
- `transcript.json` (whisper-cli `small.en`, model borrowed from
  `~/.cache/hyperframes/whisper/models/ggml-small.en.bin` — MV1 must download its own),
- `build.py` (transcript → cuts → `index.html`: 6 footage segments, 137 caption spans,
  cards, zooms, grade, SFX),
- `assets/sfx/*` (copied from a HyperFrames project — **Pixabay-licensed, must not be
  redistributed**; MV4 replaces them),
- renders `fiverr-update.mp4`, `fiverr-update-v2.mp4`.
The owner's style guide is `~/hf-test/@dylwill/style-guide.md` — an example of a mature
user style file. **Never copy its values into the product** (17 §0 rule 1).

## 5. Divergences from the plan (resolve during MV0)

- Media trim attribute: plan canonical `data-media-start`; code uses `data-trim-start`
  (video) and `data-audio-start` (audio). → MV0.1.
- Studio is a single HTML file, not the Vite/React app in `08`. Keep it working; the
  MV6 chat panel may be built in it first, then migrated with T10.2.
- CLI is built on `citty` with commands in `packages/cli/src/cli.ts`; there is no
  `errors.ts` / JSON envelope yet. → MV0.4 / MV1.
- `ensureChrome` stores browsers under `~/.donova/chrome/` (plan says
  `~/.cache/donova/`). Pick one in `names.ts` and migrate.
- No `@donova/media`, `@donova/sdk`, `@donova/agent` packages yet.

## 6. Environment of the owner's machine

macOS (Apple silicon), Node 23.9, pnpm 9.15, FFmpeg 9.0.2, `whisper-cli` via Homebrew,
Chrome Headless Shell 141 and 157 under `~/.donova/chrome/`. No Bun.
