# STATUS — what exists today (read before building)

Last updated: 2026-11-07 (fix pass — all P0s + most P1s resolved; see §0). Update this file whenever you finish an MV task.

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
2. **`data-fc-motion` timing**: anim `t` is now relative to `el.closest("[data-start]")`
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
7. **MCP**: `framecraft_check`/`framecraft_snapshot` signatures fixed; server exits on stdin EOF.
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
- Registry: `block.json` `vars` regenerated from actual `--fc-*`/`data-fc-var` usage (dead vars
  removed, missing declared); `caption-strip` got `top:auto` (was stretched by `.clip{inset:0}` CSS).

### Still open (deferred, not blocking)
- **U²-Net edge slack**: cutout keeps a ~20–60px background halo on plain-wall shots — model
  resolution limit, not plumbing. Plan's answer is the MODNet eval (MV8 noted in 17-VIBE-EDIT).
- **Anthropic chat path untested** — no `ANTHROPIC_API_KEY` on this machine; the loop is implemented
  but needs a live key to verify.
- **Studio timeline lanes**: clips still render one-per-row (no lane packing). Cosmetic.
- **`clip-past-duration` warnings** (16 on fc-e2e): some generated caption clips extend ~0.5s past
  the 41.84s plan duration. Harmless but should be clamped in `captions`.
- **Block defaults are centered**: stat/card blocks cover the face at default position. Agents/users
  should position them; consider a `--fc-y` offset convention later.
- **Sub-comp scaling semantics**: inner `data-fc-motion` times scale to the host clip duration — by
  design, but document it in block authoring notes.
- **`framecraft check` warnings** don't distinguish block-sourced vs user clips in messages.
- **Error codes**: most non-validation failures still return `E_INTERNAL` (unknown block, tts
  provider, missing file). citty's missing-positional-arg error bypasses `--json` (prints help text).
- **Missing `data-composition-src` targets** surface only as a browser 404 in `check`; no static
  fs-existence lint rule yet.
- **`remove-background` video path** is untested (image path verified); the Studio
  "Remove background" inspector button (MV8) is not built; `edge`/`kokoro` TTS providers are stubs.
- **`eval` draft render** writes `eval-render.mp4` at the project root instead of `.framecraft/`.
- **No `clean` command** for `.framecraft/frames` cache (~hundreds of MB on real footage).

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
7. **MCP `framecraft_check` and `framecraft_snapshot` throw** (`paths[0] must be string`): `mcp.ts`
   calls `checkProject({dir})` and `snapshotTimes({...})`, but the signatures are
   `checkProject(dir, composition?, opts?)` and `snapshotTimes(dir, composition, times, outDir)`. Also
   `framecraft mcp` never exits on stdin EOF (`await new Promise(() => {})`): add `stdin.on("end", exit)`.
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
    serial (92s); pass `scale: 0.5`, `workers: auto`, write to `.framecraft/`, not the project root.
15. Temp leaks: `*.video-only.tmp.mp4` left next to every output; `.framecraft/render-<ts>/` worker
    dirs (195 MB on the E2E) never deleted; `.framecraft/frames` (173 MB) has no `clean` command.
16. Registry blocks:
    - `caption-strip` renders as a full-height dark bar in any project whose CSS has
      `.clip{inset:0}` (scaffold emits exactly that). Blocks must set `top:auto`/explicit box, or
      scaffold should scope its rule to `.clip > video`.
    - Declared vars with no effect: `card.pos`, `progress-bar.pos`, `flash.color` (HTML reads
      `--fc-flash`), `flash.dur`, `zoom-transition.from/to/dur` (JSON motion can't read CSS vars),
      `fade-title` uses a dict-shaped `vars` with key `--fc-title-color` (schema inconsistent).
    - Many CSS vars used but undeclared (e.g. card has 15) — declare them in `block.json`.
    - Sub-comp time scaling stretches a block to the host's duration (a 0.12s `flash` on a 3s host
      lasts 3s). Make scaling opt-in (`data-scale="fit"`) or document host duration = block duration.
    - New blocks' `block.json` lack `type`/`version`/`files` that the original two have.
17. `framecraft catalog` is referenced 5× in skills but the command doesn't exist (`Unknown command`).
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
26. `pnpm typecheck` fails in `@framecraft/cli`: `captions.ts` `units` typed as `Array<{…}>[]`
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
FC="node packages/cli/bin/framecraft.mjs"
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
| `contract` | working | `names.ts` (all names), parse5 parser, timecode parsing, timing compiler (`resolveTimeline`, nested sub-comps, `data-clip-absolute`, speed), `planRender`, `data-fc-motion` parser/validator, JSON schemas in `schemas/`. Exported parse fn is `parseCompositionHtml` (not `parseComposition`). |
| `runtime` | working | Browser IIFE built to `dist/runtime.global.js`. Root sizing from `data-width/height`, clip visibility + `data-fade-in/out`, GSAP root timeline seek, WAAPI/CSS adapter, `data-fc-motion` adapter (split words/chars, stagger, eases), deterministic video frame overlays from `.framecraft/video-map.json`, media seek, `__renderReady` gate. |
| `engine` | working | ffmpeg locate/run, Chrome Headless Shell ensure/launch, static file server (Range, `.framecraft/*` misses → 204), capture (beginFrame + screenshot), sacrificial-browser beginFrame probe with cached verdict (`~/.framecraft/probes/`), streaming encoder (h264/h265/vp9/prores, alpha), chunk encoder, video frame pre-extraction (JPG). |
| `producer` | working | `render()`: parse → plan → extract video frames → serial or parallel capture → audio mix (trim/volume/fades/delay/amix) → mux. Formats: mp4, webm(vp9+opus), mov, gif, png-seq, hls. Parallel = equal contiguous frame ranges, one browser per worker, one retry. |
| `cli` | working | `init`, `check` (`--json`), `preview`, `render` (`--workers --format --quality --fps --alpha`), `studio`, `snapshot --times`, `compare <a> <b>` (PSNR), `add <block>`. No JSON envelope on most commands; progress uses `\r`. |
| `lint` | minimal | Small static rule set + summary/format helpers. Far from the ~100 rules in `07`. |
| `player` | minimal | `<framecraft-player>` web component. |
| `studio-server` | minimal | Vanilla Node HTTP server + single-file UI `src/ui/index.html` (no Vite/React/dockview). Endpoints: `GET /api/spec`, `GET/PUT /api/file`, `POST /api/mutation` (byte-preserving timing/text edits by timed-element index), `GET /api/lint`, `POST /api/render` + `GET /api/render/:id`, `GET /api/files`, `/studio/*`. UI: canvas iframe, timeline tracks, drag-to-retime, click-to-pick, inspector (start/duration/text), lint panel, render button. |

Other: `registry/` (2 blocks: `fade-title`, `caption-strip`; `catalog.json`),
`skills/framecraft-core/SKILL.md`, `apps/render-worker/Dockerfile` (untested build),
`fixtures/basic` (GSAP + motion), `fixtures/media` (video + audio), `tests/contract.test.ts`
(17 tests).

## 2. Commands that work

```bash
pnpm install
pnpm build                 # 8/8 packages
pnpm vitest run            # 17 tests (NOTE: `pnpm test` runs turbo; packages have no test scripts)
pnpm lint                  # biome
node packages/cli/bin/framecraft.mjs check fixtures/media
node packages/cli/bin/framecraft.mjs render fixtures/basic --out /tmp/out.mp4 [--workers 4]
node packages/cli/bin/framecraft.mjs snapshot fixtures/basic --times 0,0.5,1 --out snaps
node packages/cli/bin/framecraft.mjs studio fixtures/media --port 8788   # http://127.0.0.1:8788/studio/
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
6. **Overlay'd videos are not element-seeked** (`data-fc-overlay="1"`); their audio
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
    to `~/.cache/framecraft/parakeet/` with size+sha256 pins at a fixed HF
    revision. Decode runs in `sherpaWorker.ts` child process (onnxruntime can
    abort uncatchably); audio is silence-cut into ~30s windows, gaps with
    residual energy get re-decoded + spliced (`parakeet.ts`). Whisper remains
    the fallback for unsupported platforms/languages (`--language` swaps `.en`
    models for multilingual twins). `framecraft models [install parakeet]`
    lists/prefetches. Verified on IMG_4063: Fiverr correct ×2 with no prompt,
    proper punctuation/casing, zero fragments. Parakeet is CC-BY-4.0 —
    attribution lives in README Notices. Whisper.cpp binary auto-build is NOT
    implemented (HF builds from source; we still require brew install).

Performance reference: 42 s 1080×1920 reel, 1265 frames, screenshot mode, 4 workers
on this Mac → **11 min 18 s**. Basic fixture (640×360, 2 s) → 4.7 s.

## 4. Reference project (local only — not in the repo)

`~/hf-test/@dylwill/projects/fc-4063/` — the owner's talking-head clip edited with this
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
- `ensureChrome` stores browsers under `~/.framecraft/chrome/` (plan says
  `~/.cache/framecraft/`). Pick one in `names.ts` and migrate.
- No `@framecraft/media`, `@framecraft/sdk`, `@framecraft/agent` packages yet.

## 6. Environment of the owner's machine

macOS (Apple silicon), Node 23.9, pnpm 9.15, FFmpeg 9.0.2, `whisper-cli` via Homebrew,
Chrome Headless Shell 141 and 157 under `~/.framecraft/chrome/`. No Bun.
