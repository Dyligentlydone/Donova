# STATUS — what exists today (read before building)

Last updated: 2026-11-07 (full test pass — see §0). Update this file whenever you finish an MV task.

The original plan (`00`–`16`) describes a from-scratch build. A first working version
was built quickly (≈ 4.2k lines of TS) and **partially** covers M0–M6. Most tasks in
`16-BUILD-ORDER.md` are *not* ticked because their full acceptance criteria (CI,
golden harness, full lint set, etc.) were never met. Treat existing code as a working
foundation to harden, not as finished tasks.

**Priority now:** the MV track in `17-VIBE-EDIT.md` / `16-BUILD-ORDER.md`.

## 0. Test pass 2026-11-07: open issues (START HERE)

MV0–MV10 code exists (commits `4069a8f`, then the MV3–MV6 commit; MV8–MV10 + the
`bgRemoval` fix are in the working tree / latest commit). Sections 1–2 below are
partly stale (e.g. `vitest.golden.config.ts` now exists; the CLI has ~22 commands).
A full test pass was run; this list is the work remaining, **in priority order**.
Re-run the "How it was tested" block after each fix.

### Verified working
- `pnpm build` 9/9, `pnpm test` 17/17, `pnpm test:golden` 2/2 (byte-identical GSAP fixture, media fixture).
- Real footage E2E on `IMG_4063.MOV` (rotated −90°, 47.8s): `init --footage` → `transcribe` (155 words)
  → `cuts` (6 segs, 5.96s removed) → `scaffold` 1080×1920 → `add stat-card/sfx-impact` → `captions`
  (155) → `check` (0 errors) → `render --workers auto`: **1255 frames, 41.8s, h264+aac in 47s**
  (was ~11 min). Framing + captions correct in the MP4. Raw footage md5 unchanged.
- `doctor`, `style init/show/path`, `skills update`, `copy-prompt`, `add` (blocks + sfx), `probe`,
  `timeline`, `check`, `snapshot`, `render` mp4/webm/gif/`--range`/`--draft`/`--workers`, `tts --provider say`,
  `eval`, `mcp` initialize/tools/list/probe/timeline/cuts/style. `remove-background` runs end to end
  (model download, CoreML inference, clean 320² person mask) but the **output alpha is still striped**; see the fix notes below.
- GSAP timeline seeks correctly (3 distinct frames). Sub-comp loading + `data-var-*` text/CSS slots work.
- Studio server: `/api/spec|assets|lint|style|turns|chat|undo|render` respond; path traversal blocked on
  `/api/file` GET+PUT; render job produced an MP4.
- 16 blocks: `check` clean, no runtime errors, no Date/random/setInterval.

### P0 — broken core behaviour
1. **Studio preview is dead in a real browser.** The UI (`:4141`) iframes the composition from a
   *different* port (`startFileServer`, e.g. `:62668`) → cross-origin; every
   `frame.contentWindow.__fc/__playerReady/contentDocument` access throws `SecurityError`. Also the
   runtime is never injected into the iframe page (`typeof __fc === "undefined"`), so: no scaling, no
   seek/play (timecode stuck 0.00), no clip visibility (all 155 captions drawn at once), Pick broken.
   Fix: serve the project from the studio server itself under `/project/*` (same origin) and inject
   `<script src="/runtime.js">` (runtime `dist/runtime.global.js`) into served HTML.
   Files: `packages/studio-server/src/server.ts`, `src/ui/index.html`.
2. **`data-fc-motion` on a non-timed child animates at absolute t=0.** `buildMotionAnims` uses the
   element's own `data-start` (`packages/runtime/src/browser.ts` ~L208); should use
   `el.closest("[data-start]")`. Effect: every block with motion on an inner div (stat-card, card,
   alert-card, cta, title-card, lower-third…) and every generated caption pop is invisible/static
   unless placed at t≈0. Confirmed: stat-card at 20s never appears in the E2E render.
3. **Rotated footage in preview/snapshot.** `scaffold` ignores `side_data rotation` (iPhone −90°):
   it uses 1920×1080 for cover math → `<video>` box 3413×1920 with `object-fit:fill` → stretched/over-zoomed
   in Studio + `snapshot`. The render looks right only because ffmpeg auto-rotates extracted frames.
   Fix: swap w/h when |rotation| = 90 in `probe` (`packages/cli/src/inspect.ts` / engine ffprobe) and use
   `object-fit:cover` with `width/height:100%` in `packages/media/src/scaffold.ts`.
4. **Alpha render produces opaque output.** Transparent-background comp → `--format webm --alpha`
   gives alpha min 228 (should be 0 outside content). Capture input is `rgb24`; screenshot needs
   `omitBackground: true` + transparent default background (CDP `Emulation.setDefaultBackgroundColorOverride`
   rgba 0) when `alpha`. Files: `packages/engine/src/capture.ts`, `renderer.ts`.
5. **`--format mov` fails both ways.** `producer/src/render.ts` L83 writes the ProRes temp as `.mp4`
   (use `.mov` for prores); `engine/src/encoder.ts` L92–95: `-profile:v 422` invalid for prores_ks (use
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
