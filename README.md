# Donova

HTML → video, deterministically. Write a composition as a web page; Donova seeks Chrome frame-by-frame and encodes the result with FFmpeg.

Status: working core (M0–M5 of `plan/16-BUILD-ORDER.md`). Built fresh against the contract in `plan/` — architecture informed by studying HeyGen's open-source HyperFrames (Apache-2.0, reference in `_analysis/`).

## Quick start

```bash
pnpm install && pnpm build
node packages/cli/bin/donova.mjs init my-video --name demo --duration 5
cd my-video
node ../packages/cli/bin/donova.mjs check    # lint + headless gate
node ../packages/cli/bin/donova.mjs preview  # scrub in browser
node ../packages/cli/bin/donova.mjs render --out out.mp4 --workers 4
```

## What works now

- **Composition contract**: `data-composition-id`, `data-start`/`data-duration`/`data-end`, `data-track-index`, `data-fade-*`, `data-speed`, `data-clip-absolute`, `data-audio-*`, `data-trim-*`, `data-composition-src`, `data-do-motion` (`@donova/contract` — parse5 parser, timing compiler, JSON schemas).
- **Runtime**: injected IIFE — paused-timeline seek for GSAP (`__timelines`), WAAPI/CSS animations, declarative `data-do-motion` with word/char splitting + stagger, clip visibility windows, fades, deterministic video-frame overlays (extracted PNGs, never Chrome seeking), media sync, readiness gates (`__renderReady`).
- **Engine**: `chrome-headless-shell` via puppeteer-core, beginFrame capture (proper `HeadlessExperimental.enable` + `frameTimeTicks` protocol, sacrificial-browser probe with cached verdict), screenshot fallback, streaming image2pipe → libx264/h265/vp9/prores encode, alpha support.
- **Producer**: `render()` pipeline — parse → plan (cut-bounded segments) → video-frame extraction → parallel workers → chunked concat → FFmpeg audio graph (atrim/volume/afade/adelay/amix) → mux.
- **CLI** (`donova`/`do`): `init`, `check` (static lint + headless browser gate + layout probe), `preview` (scrub UI), `render`, `studio`.
- **Studio server**: `/api/spec|file|mutation|lint|render|files` — byte-preserving parse5 splice mutations addressed by domIndex; bundled editor UI (canvas iframe, timeline tracks, inspector, render button).
- **Player**: `<donova-player>` web component (iframe host, rAF preview clock, seek API).
- **Registry**: `registry/blocks/*` + `catalog.json` (fade-title, caption-strip starters).
- **Render worker**: `apps/render-worker/Dockerfile` — pinned node + chrome-headless-shell + ffmpeg; studio server exposes `POST /api/render` as the job endpoint.
- **Skills**: `skills/donova-core/SKILL.md` — the contract for agents.
- **Tests**: `tests/contract.test.ts` (17 tests: time parsing, spec parse, timing resolve, render plan, motion validation).

## Verified

- `fixtures/basic` (GSAP + data-do-motion) → 60-frame MP4; re-renders are **byte-identical**; PSNR vs parallel render ≈ 52dB.
- `fixtures/media` (video clip + audio bed) → MP4 with h264 + AAC; extracted video frames hit exact media timestamps.
- `init → check → render` loop passes clean on a scaffolded project.

## Layout

```
packages/contract   parser, timing, motion, names, schemas, types
packages/runtime    browser runtime (dist/runtime.global.js injected)
packages/engine     chrome, capture, encoder, ffmpeg, file server, video frames
packages/producer   render(), audio mix/mux, parallel sharding
packages/player     <donova-player>
packages/lint       static contract + determinism checks
packages/studio-server  Studio API + editor UI
packages/cli        donova / do
apps/render-worker  Dockerfile for the render server
registry/           blocks + catalog
skills/             agent skills
fixtures/           test compositions
plan/               the full build spec (source of truth)
tests/              vitest unit tests
```

## Notes

- GSAP stays a code-path only: Studio/no-code surfaces never emit GSAP — they write `data-do-motion` (see `plan/12-CLOUD-PLATFORM.md §9`). License: GSAP Standard (Webflow) — free for this use; get written confirmation before commercial launch.
- beginFrame needs `chrome-headless-shell` and a (virtual) display; on headless hosts without one the engine auto-falls back to screenshot capture — verdict cached in `~/.donova/probes/`.
- Product name is centralized in `packages/contract/src/names.ts`.

## Notices

- Speech recognition may use **NVIDIA Parakeet-TDT 0.6B v3** (`--engine parakeet`, the default `auto` preference), licensed [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) — © NVIDIA Corporation. Converted int8 ONNX build: [csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8).
- Whisper fallback runs **whisper.cpp** (MIT) with OpenAI Whisper ggml models (MIT).
- sherpa-onnx runtime: Apache-2.0 (k2-fsa).
