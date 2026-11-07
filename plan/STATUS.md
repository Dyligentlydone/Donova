# STATUS — what exists today (read before building)

Last updated: 2026-11-06. Update this file whenever you finish an MV task.

The original plan (`00`–`16`) describes a from-scratch build. A first working version
was built quickly (≈ 4.2k lines of TS) and **partially** covers M0–M6. Most tasks in
`16-BUILD-ORDER.md` are *not* ticked because their full acceptance criteria (CI,
golden harness, full lint set, etc.) were never met. Treat existing code as a working
foundation to harden, not as finished tasks.

**Priority now:** the MV track in `17-VIBE-EDIT.md` / `16-BUILD-ORDER.md`.

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
