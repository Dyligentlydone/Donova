# 16 — Build Order (the task list)

Each task: **spec** reference, **deps**, and **done when** (acceptance).
Tick `- [x]` when done; add a one-line note for any decision.

> **Current priority: the MV track below.** A first working version of M0–M6 already
> exists (see `plan/STATUS.md`); M-tasks stay unticked until their full acceptance
> criteria pass. Do MV tasks in order; pull in M-tasks only where an MV task names
> them as a dependency. Spec for every MV task: `plan/17-VIBE-EDIT.md`.

---

## MV — Vibe-edit track (DO THIS FIRST)

North star (17 §0): a user drops in footage, describes the edit, an agent produces it,
and their lasting preferences go to *their* `style.md`. No creator style is built
into the app.

### MV0 — Stabilize
- [ ] **MV0.1 Canonical `data-media-start`** — 17 §3.1.1. Deps: none. Done when: one attribute drives video frames + audio; old names accepted with lint info + autofix; media fixture and reference-style multi-segment test pass.
- [ ] **MV0.2 Alpha-aware frame extraction** — 17 §3.1.2. Done when: WebM-alpha and ProRes-4444 fixtures render with transparency over a colored background; opaque videos still extract JPG.
- [ ] **MV0.3 Tests that run** — 17 §3.1.3. Done when: `pnpm test` runs all unit tests; `pnpm test:golden` exists and runs determinism, frame-accuracy, parallel-vs-serial checks.
- [ ] **MV0.4 JSON output contract + error codes** — 17 §4.1. Done when: contract test runs every command with `--json` (envelope + exit codes 0/1/2); unattended progress is newline-terminated.
- [ ] **MV0.5 `check` noise fixes** — 17 §3.1.5. Done when: motion-only projects get no `no-animations`; audio holder elements don't warn `clip-missing-class`.

### MV1 — Agent tool layer
- [ ] **MV1.1 `doctor`** — 17 §4.2. Done when: every check implemented with fix hints; `--json` schema test; exit 1 on any fail.
- [ ] **MV1.2 `transcribe` (own whisper install + model download)** — 17 §4.3, 10 §2. Done when: model downloads with sha256 verify + resume; `transcript.json` matches schema; WER/timing criteria (10 §9); cache hit on rerun; `E_WHISPER_MISSING` hint per OS. Never reads `~/.cache/hyperframes`.
- [ ] **MV1.3 `cuts` (`@donova/media`, pure core)** — 17 §4.4. Done when: unit tests (gap collapse, fillers, keep/drop, no truncated words, monotonic remap, idempotent); `sourceToComp`/`compToSource` exported.
- [ ] **MV1.4 `scaffold footage`** — 17 §4.5. Done when: generated `index.html` passes `check` with 0 errors for 9:16, 16:9, 1:1; no grade/zoom/cards/SFX in output.
- [ ] **MV1.5 `probe`, `timeline`, `snapshot --contact-sheet`, `render --draft/--range`, `catalog`, worker auto-sizing** — 17 §4.6. Done when: each has `--json`; contact sheet labeled with timecodes; draft renders at half size.
- [ ] **MV1.6 `init --footage`** — 17 §1 layout + 6.3 AGENTS/CLAUDE.md. Done when: scaffolds the layout, copies media into `assets/raw/`, writes agent instructions pointing to skills + style file.

### MV2 — Style file
- [ ] **MV2.1 `style init|show|path` + resolution (project → global via `donova.json`)** — 17 §5.1–5.2. Done when: unit tests for resolution order; template matches §5.2.
- [ ] **MV2.2 SDK `style()` / `updateStyle()`** — 17 §5.3. Done when: update appends a decisions row, never deletes user lines, marks superseded entries.

### MV3 — Skills
- [ ] **MV3.1 Router skill update (`donova`)** — 17 §6.1.
- [ ] **MV3.2 `donova-footage` + all references** — 17 §6.2. Done when: every listed reference exists; code-block extraction test lints/renders every `html composition` block.
- [ ] **MV3.3 `donova-cli`, `donova-registry`, `donova-motion`** — 17 §6.1.
- [ ] **MV3.4 `skills update/list`** — 09 §3, 17 §6.3. Done when: installs into all agent dirs; modified skill not overwritten without `--force`.

### MV4 — Blocks + SFX
- [ ] **MV4.1 Block format v2 (`vars`, `slots`, `snippet.html`, `preview.mp4`) + validate script** — 17 §7.1, 11 §2/§4.
- [ ] **MV4.2 Footage blocks (all 14 in 17 §7.2) + motion presets** — Done when: each passes validate, renders a preview, themes via vars only; neutral defaults reviewed.
- [ ] **MV4.3 `add word-captions --from cuts.json` generator** — 17 §7.2. Done when: generates spans with `data-word-id`; renders the reference-length (≈140 words) captions without sharding the render plan.
- [ ] **MV4.4 SFX library (synth script + CC0 only) + `add sfx/*`** — 17 §7.3. Done when: 15 sounds with `sfx.json` + `LICENSES.md`; no Pixabay files anywhere in the repo; install prints wiring snippet.

### MV5 — SDK + MCP
- [ ] **MV5.1 `@donova/sdk`** — 17 §8.1. Done when: CLI commands call the SDK (no duplicated logic); unit tests per op; writes return lint summaries.
- [ ] **MV5.2 `donova mcp`** — 17 §8.2. Done when: MCP inspector lists tools; snapshot tool returns images; Claude Code setup documented and manually verified.
- [ ] **MV5.3 "Copy prompt for your agent" in Studio** — 17 §8.3.

### MV6 — Studio vibe-edit chat
- [ ] **MV6.1 `@donova/agent` loop + Anthropic provider + tools on SDK** — 17 §9.1–9.3, 09 §4. Done when: fake-provider scripted test passes.
- [ ] **MV6.2 studio-server agent endpoints (turn, SSE stream, abort) + history snapshots/undo turn** — 17 §9.1, §9.4. Done when: undo restores byte-for-byte; path-escape test rejects.
- [ ] **MV6.3 Chat panel UI + Style panel + Assets panel (SFX play/drag)** — 17 §9.5, §5.4, §7.3. Done when: preview updates < 1 s after agent writes, keeping playhead.
- [ ] **MV6.4 Real-provider smoke test** — 17 §9.6 (env-gated). Done when: §0 scenario + style write-back pass.

### MV7 — Render speed
- [ ] **MV7.1 `render --profile`** — 17 §10.1.
- [ ] **MV7.2 Draft mode, overlay preloading, ready-wait tightening, worker sizing** — 17 §10.2–10.5. Done when: targets met or documented with profile numbers.
- [ ] **MV7.3 Linux beginFrame verification in the render-worker image** — 17 §10.6.

### MV8 — Background removal
- [ ] **MV8.1 Model bake-off (U²-Net vs MODNet vs winner+smoothing+guided filter)** — 17 §11.3. Done when: results + choice in `plan/DECISIONS.md` with frames and flicker numbers.
- [ ] **MV8.2 `remove-background` command + Studio button** — 17 §11. Deps: MV0.2. Done when: §11 acceptance.

### MV9 — TTS
- [ ] **MV9.1 `tts` (Kokoro local default, `say` fallback, ElevenLabs/OpenAI)** — 17 §12. Done when: returns path + duration + word timings for each provider; `doctor` reports provider availability.

### MV10 — Evals + track acceptance
- [ ] **MV10.1 `evals/vibe/` fixtures, briefs, scorer, nightly job** — 17 §13.
- [ ] **MV10.2 Track acceptance** — 17 §13 last paragraph (Studio chat + MCP scenarios pass, grep shows no creator-specific style values in `packages/` or `skills/`, eval mean ≥ 70%).

---

## M0 — Scaffold

- [ ] **T0.1 Monorepo skeleton** — spec 00 §4–5. pnpm workspace, turbo, tsconfig.base (strict), Biome, vitest workspace config, empty packages with `package.json`/`src/index.ts`/`tsup.config.ts`, root scripts (`build`, `test`, `lint`, `typecheck`, `test:golden`).
  Done when: `pnpm install && pnpm build && pnpm test && pnpm lint` succeed.
- [ ] **T0.2 Names module** — AGENTS.md "Naming". `packages/contract/src/names.ts` exports every name constant.
  Done when: grep shows no hard-coded `__fc`, `donova`, `DONOVA_` strings outside names.ts (except docs/tests).
- [ ] **T0.3 CI** — spec 15 §6 `ci.yml` (build, lint, typecheck, unit). Done when: green on a PR.
- [ ] **T0.4 Render Docker image (dev)** — `apps/render-worker/Dockerfile` with Node 22, ffmpeg 7, pinned chrome-headless-shell, fonts. Done when: `docker run … ffmpeg -version && chrome-headless-shell --version`.
- [ ] **T0.5 Fixture media generator** — spec 15 §2 (barcode video, beep audio, VFR, rotated, 29.97, HEVC10). Done when: script generates all and a decoder test reads barcode frame numbers back.

## M1 — Render loop (prove the core)

- [ ] **T1.1 ffmpeg locate + run helper** — 03 §1 (`ffmpeg/locate.ts`, `ffmpeg/run.ts`). Done when: version parsed; abort kills process; stderr tail in errors.
- [ ] **T1.2 Chrome ensure + launch** — 03 §2. Done when: `ensureBrowser()` idempotent; launches in both modes; `probeBeginFrame` true on Linux Docker, false/skipped on macOS.
- [ ] **T1.3 File server** — 03 §1 `fileServer.ts`: static, MIME, Range, HTML injection hook, `127.0.0.1` random port. Done when: Range request test passes; injection inserts at head start.
- [ ] **T1.4 Minimal runtime v0** — 02 §2, §4 (only: root lookup, GSAP adapter, `renderSeek`, `renderReady`). Done when: browser test seeks a GSAP fixture out of order and pixel hash per frame is stable.
- [ ] **T1.5 Capture session (both modes)** — 03 §3. Done when: captures 150 frames of fixture `gsap-basic` in each mode.
- [ ] **T1.6 Streaming encoder** — 03 §6.1–6.2. Done when: 150 JPEG frames → valid MP4 (ffprobe: 150 frames, 5.0 s, yuv420p, faststart).
- [ ] **T1.7 `render()` v0 + CLI `render` v0** — 04 §1 (subset), 06. Done when: `donova render fixtures/engine/gsap-basic/project -o out.mp4` works; Docker determinism test passes (spec 15 §4).

## M2 — Contract + runtime

- [ ] **T2.1 Contract parser** — 01 §10 (parse5 with positions; linkedom DOM). Done when: parses all fixtures with source ranges.
- [ ] **T2.2 Timing compiler** — 01 §5 (refs, offsets, cycles, durations, nested abs time, fps math). Done when: unit tests for every rule in 01 §5 and §11.
- [ ] **T2.3 Automation lanes + rate integral** — 01 §6. Done when: integral tests for linear and eased segments (±1 ms).
- [ ] **T2.4 JSON schemas** — 01 §9, §11. Done when: schemas validate fixtures, reject invalid samples.
- [ ] **T2.5 Runtime: boot sequence** — 02 §3 (shims, mount, timing, wait timelines, settle). Done when: determinism-shim fixture renders identically twice; timeline timeout produces diagnostic.
- [ ] **T2.6 Runtime: sub-compositions** — 02 §3 step 3, 01 §8 (external + inline, instance ids, URL rewriting, script order, buildReady). Done when: fixture mounting the same file twice with different variables renders both correctly.
- [ ] **T2.7 Runtime: visibility & nested clocks** — 02 §4. Done when: boundary fixtures (start/end exact frames, nested with playback-start & rate) match goldens.
- [ ] **T2.8 Variables & bindings** — 01 §7, 02 §2. Done when: CLI `--var` override, host values, defaults precedence test; `data-bind-*` fixture passes.
- [ ] **T2.9 Adapters: waapi-css, lottie, animejs, three, custom** — 02 §5. Done when: each adapter fixture passes the out-of-order seek hash test.
- [ ] **T2.9b Declarative motion (`data-do-motion`)** — 01 §6b, 02 §5 `motion` adapter (schema, ease mapping incl. `linear()` for back/elastic/bounce, individual transform props, text splitting, stagger). Done when: motion fixtures pass the out-of-order seek hash test; a fixture combining GSAP `transform` + motion `translate` on one element renders both composed correctly.
- [ ] **T2.10 Golden harness** — 15 §3. Done when: `pnpm test:golden` runs all contract + adapter fixtures in Docker with PSNR/SSIM report.

## M3 — Media

- [ ] **T3.1 Probe + cache** — 10 §1, 03 §4 step 1. Done when: all fixture media probed correctly (rotation, VFR, HDR flags).
- [ ] **T3.2 Compile pipeline** — 04 §3 (vendor scripts, remote assets, video→img replacement, image prep, runtime config injection, stage bg). Done when: compiled bundle renders offline.
- [ ] **T3.3 Font localization** — 04 §3.3. Done when: Google Fonts fixture renders offline identically after first run; missing font warning emitted.
- [ ] **T3.4 Video frame extraction + cache** — 03 §4. Done when: barcode fixture with trim (`data-media-start`), rate 0.5/2.0, 29.97 source, rotated phone clip all show exact expected frame numbers at sampled times.
- [ ] **T3.5 Frame injection** — 03 §5 + 02 §6.2. Done when: same barcode tests pass through full render.
- [ ] **T3.6 Audio mixer** — 03 §7.1–7.2, 7.6 (trim, rate/atempo, volume, fades, delay, amix, mux). Done when: beep fixture offsets ±1 ms; fade RMS checks ±0.5 dB.
- [ ] **T3.7 Volume/rate automation in audio** — 03 §7.2, 01 §6. Done when: automation fixture RMS curve matches expected within ±0.5 dB at 10 points.
- [ ] **T3.8 Audio FX + groups + ducking** — 03 §7.3, §7.5. Done when: each fx id produces expected spectral/level change on test tone; ducking reduces music ≥ 10 dB under voice.
- [ ] **T3.9 Loudness normalize** — 03 §7.4. Done when: output measures −14 ± 0.5 LUFS.
- [ ] **T3.10 Animated GIF + HEIC** — 04 §3.6. Done when: GIF fixture frame-accurate; HEIC displays.
- [ ] **T3.11 Producer stages, progress, errors, history** — 04 §2, §6, §8. Done when: progress monotonic 0→100; each error code reachable via a fixture/test; history entry written.

## M4 — Player, preview, check

- [ ] **T4.1 Runtime preview clock + media sync + Web Audio mix** — 02 §6.1, §7. Done when: Playwright plays fixture 3 s; video drift < 0.15 s; audio graph applies volume/fades.
- [ ] **T4.2 Runtime bridge + pick mode + diagnostics** — 02 §8–10. Done when: bridge test (play/pause/seek/state/ready/pick) passes.
- [ ] **T4.3 `<do-player>`** — 05 all. Done when: 05 §6 criteria pass.
- [ ] **T4.4 studio-server minimal (serve project + runtime + live reload)** — 08 §11 (`/p/*`, `/__fc/*`, WS file-changed). Done when: editing a file reloads an open player within 300 ms.
- [ ] **T4.5 CLI `preview` (+ `--background/--status/--stop`)** — 06 §1. Done when: 06 §5 preview criterion passes. (Studio UI can be a placeholder page with the player until M10.)
- [ ] **T4.6 Lint engine + structure/contract/script/media rules** — 07 §1–2. Done when: fixtures for those categories pass; `--fix` works for fixable rules.
- [ ] **T4.7 GSAP call index + GSAP rules** — 07 §3, §2 GSAP. Done when: index resolves positions (`<`, `>`, `+=`, labels) correctly on 20 test scripts; GSAP rule fixtures pass.
- [ ] **T4.8 CSS, captions, audio, perf rules** — 07 §2. Done when: fixtures pass.
- [ ] **T4.9 Browser check** — 07 §4 (sampling, overflow, safe zones, contrast, overlap, blank/static, contact sheet). Done when: 07 §5 check criterion passes.
- [ ] **T4.10 CLI `lint`, `check`, `snapshot`, `compare`** — 06. Done when: JSON outputs validate against schemas; snapshot pixels equal render frames (parity test 15 §4).

## M5 — Performance & robustness

- [ ] **T5.1 Chunk encoder + concat** — 03 §6.3. Done when: chunked output frame-identical to streaming output.
- [ ] **T5.2 Parallel coordinator** — 03 §8 (auto sizing, balanced ranges, retry, low-memory). Done when: 03 §10 parallel criterion + ≥ 3× speedup budget (15 §5).
- [ ] **T5.3 beginFrame damage reuse + CDP frame injection fast path** — 03 §3, §5. Done when: goldens still pass with both enabled; measured speedup logged; defaults chosen per platform.
- [ ] **T5.4 Hardware encoders** — 03 §6.1 HW. Done when: `--gpu` works on macOS (VideoToolbox) and falls back cleanly when unavailable.
- [ ] **T5.5 Robustness** — browser crash recovery, protocol timeouts, disk-full detection, abort cleanup, orphan process reaper. Done when: chaos tests (kill chrome mid-render, fill disk in tmpfs) produce correct error codes and no orphans.

## M6 — CLI complete + formats

- [ ] **T6.1 Output formats** — 03 §6.1 (webm alpha, mov alpha, gif, png-sequence, hls, h265). Done when: 04 §9 format matrix passes.
- [ ] **T6.2 Resolution presets + supersampling + range render** — 04 §1, §5. Done when: 4K from 1080 comp; range equivalence test.
- [ ] **T6.3 `init` + templates + scaffolded AGENTS.md/CLAUDE.md** — 06 §1, §3, §4. Done when: every template `init → check → render` in CI.
- [ ] **T6.4 `info`, `compositions`, `timeline`, `doctor`, `browser`, `clean`, `upgrade`, `history`, `keyframes`, `batch`** — 06 §1. Done when: command matrix test passes.
  > MV note: doctor → MV1.1
- [ ] **T6.5 `render --docker`** — run producer inside published image with project mounted. Done when: output equals CI golden render hash.
- [ ] **T6.6 Producer HTTP server** — 04 §7. Done when: 04 §9 server criterion passes.
- [ ] **T6.7 Telemetry (opt-in)** — 06 §1 Telemetry. Done when: no network calls when disabled (test with request interception); events schema documented.

## M7 — Media AI

- [ ] **T7.1 whisper.cpp install + transcribe** — 10 §2. Done when: WER and timing criteria (10 §9).
  > MV note: → superseded by MV1.2
- [ ] **T7.2 Captions generator + 6 caption-style blocks** — 10 §3, 11 §5. Done when: 10 §9 captions criterion; each style renders.
  > MV note: caption blocks → MV4.2/MV4.3
- [ ] **T7.3 TTS providers (say, edge, elevenlabs, openai)** — 10 §4. Done when: each returns audio + duration + word timings (or derived via transcription); provider-missing errors are clear.
  > MV note: → superseded by MV9.1 (Kokoro default)
- [ ] **T7.4 Beats, silence, loudness analysis** — 10 §6. Done when: 10 §9 criteria.
  > MV note: silence part → MV1.3
- [ ] **T7.5 Background removal (image, video)** — 10 §5 (verify model license first; log in DECISIONS.md). Done when: IoU criterion.
  > MV note: → superseded by MV8
- [ ] **T7.6 Stock + image generation providers + media ledger** — 10 §7. Done when: mocked-API tests; ledger entries written with license.
- [ ] **T7.7 Color grading (preview WebGL + render ffmpeg) + 12 looks** — 10 §8. Done when: parity PSNR ≥ 35 dB.
- [ ] **T7.8 Proxies for heavy media** — 10 §1. Done when: ProRes/HEVC10 preview via proxy, render via original.

## M8 — Skills + agent

- [ ] **T8.1 Core skills content** — 09 §2 items 1–5 (write carefully; every code sample must pass `check` — add a test that extracts code blocks tagged `html composition` and lints/renders them).
  > MV note: → MV3 first
- [ ] **T8.2 Workflow skills** — 09 §2 items 6–13.
- [ ] **T8.3 `skills update/list` + plugin manifests** — 09 §3. Done when: 09 §5 install criterion.
  > MV note: → MV3.4
- [ ] **T8.4 SDK** (`@donova/sdk`): open project, list/patch elements, timing ops, run lint/check/snapshot/render — shared by agent + studio-server. Done when: unit tests for each op with minimal-diff assertions.
  > MV note: → superseded by MV5.1
- [ ] **T8.5 Agent core: provider interface (Anthropic first), tools, loop, guardrails, context mgmt** — 09 §4. Done when: fake-provider scripted test; real-provider smoke test behind env flag.
  > MV note: → MV6.1
- [ ] **T8.6 `donova agent` CLI** — 06 §1. Done when: runs a brief end-to-end on a fixture with the real provider (manual verification recorded).
- [ ] **T8.7 Agent eval harness** — 09 §4.5. Done when: nightly job produces a score report.
  > MV note: → MV10.1

## M9 — Registry

- [ ] **T9.1 Item schema + build/validate scripts** — 11 §2, §4. Done when: validate runs lint/check/render per item.
- [ ] **T9.2 registry-client (index cache, search, install, remove, deps, scoping, fonts, wiring)** — 11 §3. Done when: 11 §6 criteria.
- [ ] **T9.3 CLI `catalog`, `add`, `remove`** — 06 §1. Done when: JSON schemas validate; install wiring test.
- [ ] **T9.4 First-party catalog (≥ 60 items)** — 11 §5. Build in batches of ~10; each passes validate and has a preview render.
- [ ] **T9.5 Registry hosting** — static deploy of `registry.json` + items + previews to CDN; catalog pages on `apps/web`. Done when: CLI installs from the hosted URL.

## M10 — Studio

- [ ] **T10.1 studio-server full API** — 08 §11 (files, mutations with minimal-diff patching, timing ops, gsap mutations, media endpoints, history, render queue SSE, registry, fonts, jobs, WS). Done when: API tests per route incl. path traversal and CSRF tests.
- [ ] **T10.2 Studio shell** — 08 §2–3 (dockview layout, stores, routing, theme). Done when: opens project, panels persist layout.
- [ ] **T10.3 Canvas + overlay selection chrome** — 08 §4 (hover, select, multi-select, measure overlay geometry, snapping guides). Done when: overlay boxes match element rects ±1 px in Playwright across scales.
- [ ] **T10.4 Direct manipulation commits (move/resize/rotate/nudge/crop; static mode + keyframe mode writing `data-do-motion`; never touch scripts)** — 08 §4. Done when: 08 §12 drag, preset, and "no script modified" criteria.
- [ ] **T10.5 Inline text editing** — 08 §4. Done when: edit text node only diff test.
- [ ] **T10.6 Inspector (all sections) + font picker + ease picker + animation presets** — 08 §5.
- [ ] **T10.7 Timeline (tracks, thumbnails, waveforms, move/trim/split/ripple, audio lanes, snapping, keyboard)** — 08 §6. Done when: 08 §12 timeline criterion; 500-clip perf budget.
- [ ] **T10.8 Save/reload protocol + conflict banner** — 08 §8. Done when: no reload flash on own writes; external edit reloads.
- [ ] **T10.9 Undo/redo (server history, grouping)** — 08 §9.
- [ ] **T10.10 Code editor tab with inline lint** — 08 §2.
- [ ] **T10.11 Panels: Files, Assets (upload, drag to timeline), Blocks (registry browse + drag in), Layers, Captions, Variables, Audio, Color** — 08 §2, §5, 10 §3, §8.
  > MV note: Assets/SFX panel → MV6.3
- [ ] **T10.12 Render dialog + queue** — 08 §10.
- [ ] **T10.13 Agent chat panel** — 08 §7, 09 §4. Done when: 08 §12 agent criterion.
  > MV note: → superseded by MV6
- [ ] **T10.14 Studio e2e suite complete** — 08 §12 all pass in CI.

## M11 — Cloud

- [ ] **T11.1 Local stack (docker-compose: postgres, redis, minio, api, worker, web)** — 12 §1.
- [ ] **T11.2 DB schema + migrations (Drizzle)** — 12 §2.
- [ ] **T11.3 Auth: web sessions + OAuth + device flow + API tokens** — 12 §3. CLI `auth login/logout/status`.
- [ ] **T11.4 Bundles + content-addressed blobs + presigned uploads** — 12 §4 steps 1–2.
- [ ] **T11.5 Render scheduler + workers + sharding + finalize + SSE + webhooks** — 12 §4. CLI `cloud render/list/status/download/cancel`.
- [ ] **T11.6 Publish + share pages + OG tags** — 12 §5. CLI `publish`.
- [ ] **T11.7 AI proxy + metering + rate limits** — 12 §6.
- [ ] **T11.8 Billing (Stripe) + credits ledger + usage reporting + dashboard** — 12 §7. CLI `usage`.
- [ ] **T11.9 Public API + OpenAPI + `@donova/cloud` SDK** — 12 §8.
- [ ] **T11.10 Production deploy** (IaC: Terraform/Pulumi for DB, Redis, R2, workers autoscaling, web), observability (OpenTelemetry traces, structured logs, Sentry), backups. Done when: 12 §10 criteria pass against staging.

## M12 — Desktop

- [ ] **T12.1 Electron shell + utility-process studio-server + preload bridge** — 13 §1.
- [ ] **T12.2 Bundled binaries + first-run downloads (chrome, whisper model)** — 13 §1, §3.
- [ ] **T12.3 Home screen, onboarding, projects folder rules** — 13 §2–3.
- [ ] **T12.4 Native integrations** — 13 §4.
- [ ] **T12.5 Signing, notarization, installers, auto-update channels, crash reporting** — 13 §5.
- [ ] **T12.6 Clean-VM acceptance (mac + win)** — 13 §6.

## M13 — Differentiators

- [ ] **T13.1 Transcript editing (EDL → split clips, word anchors, micro-fades)** — 14 §1.1.
- [ ] **T13.2 Silence & filler removal (`donova cut`, Studio button)** — 14 §1.2.
  > MV note: → MV1.3 (cuts) + skill guidance
- [ ] **T13.3 Auto-reframe** — 14 §1.3.
- [ ] **T13.4 Multicam sync** — 14 §1.4.
- [ ] **T13.5 Smart B-roll suggestions** — 14 §1.5.
- [ ] **T13.6 Style Bible analyzer + style.json + Style panel + application in workflows** — 14 §2.
  > MV note: → replaced by user-owned style.md (MV2); analyzer optional later
- [ ] **T13.7 One-click "Make it social" package** — 14 §1.6.
- [ ] **T13.8 Incremental re-rendering** — 14 §3.
- [ ] **T13.9 In-browser draft export (experimental flag)** — 14 §4.

## Launch checklist
- [ ] Legal checklist 12 §9 complete (incl. Webflow/GSAP written confirmation on file).
- [ ] Docs site complete: quickstart, concepts (contract, determinism, adapters), guides per workflow, CLI reference (generated from citty metadata), Studio guide, troubleshooting per error code.
- [ ] All CI suites green; nightly perf within budgets; agent eval ≥ 70%.
