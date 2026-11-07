# 00 — Overview

## 1. What we are building

A platform where **a video is an HTML page**. Authors (humans or AI agents) write HTML,
CSS and JavaScript animations; Framecraft turns that page into a frame-perfect,
deterministic MP4 (or WebM/MOV with alpha, GIF, PNG sequence, HLS).

On top of the rendering core we build:

| Surface | Who uses it | Purpose |
|---|---|---|
| **CLI** (`framecraft`) | developers, AI coding agents (Claude Code, Cursor, Codex) | init, preview, check, snapshot, render, transcribe, TTS, add blocks |
| **Skills** | AI coding agents | Markdown knowledge packs that teach an agent the contract and craft |
| **Studio** | creators | Browser editor: live preview, timeline, inspector, code view, AI chat |
| **Desktop app** | non-technical creators | Studio + bundled Node/FFmpeg/Chrome, zero install |
| **In-app Agent** | creators | Chat-driven editing inside Studio ("make captions bigger") |
| **Registry** | everyone | Catalog of reusable scenes ("blocks") and effects ("components") |
| **Cloud** | everyone | Accounts, cloud rendering, share links, AI media credits, billing |

Plus the differentiators in `14-DIFFERENTIATORS.md`: footage-first editing (transcript
editing, silence/filler removal, auto-reframe), the Style Bible engine, incremental
re-rendering, and in-browser draft rendering.

**North star (added 2026-11-06, see `17-VIBE-EDIT.md`, which wins on conflicts):**
Framecraft is a video editor for other people, built around **vibe editing** — the user
brings footage and describes the edit; an AI agent (external via CLI/skills/MCP, or the
built-in Studio chat) does it, and the user's lasting preferences are saved in their
own `style.md`. The product ships neutral tools, blocks, and general editing skills,
never one creator's style. The Style Bible analyzer in `14 §2` becomes optional; the
user-owned `style.md` is the primary mechanism.

## 2. The five core ideas (memorize these)

1. **A video is a web page.** A composition is an HTML file. Timing lives in `data-*`
   attributes (`data-start`, `data-duration`, …). Root carries
   `data-composition-id`, `data-width`, `data-height`, `data-duration`, `data-fps`.
2. **Animation is a paused, seekable timeline.** Authors register
   `window.__timelines["<composition-id>"] = gsap.timeline({ paused: true })`.
   Nothing plays on its own; the runtime always seeks.
3. **One injected runtime owns time.** `@framecraft/runtime` is injected into every
   composition page (preview and render). It resolves timing, mounts sub-compositions,
   shows/hides clips by time window, seeks every animation library through adapters,
   drives media, and exposes `window.__fc.renderSeek(t)`. Preview and render share it,
   which is what guarantees "what you see is what you render".
4. **Rendering steps Chrome frame by frame.** The engine launches
   `chrome-headless-shell`, and for each frame `i`: calls `renderSeek(i / fps)`, then
   captures exactly one painted frame (Linux: `HeadlessExperimental.beginFrame` with
   `--deterministic-mode --enable-begin-frame-control`; macOS/Windows: `Page.captureScreenshot`).
   Frames are piped into FFmpeg.
5. **Media is handled outside the browser.** `<video>` cannot be seeked frame-accurately
   in Chrome, so FFmpeg pre-extracts the needed frames and the render page shows those
   frames as images. Audio is never captured from the browser: the mixer reads all
   `<audio>`/`<video>` timing attributes and builds a single FFmpeg filter graph, then
   muxes it with the video.

## 3. System architecture

```
                         ┌──────────────────────────────────────────────┐
  author / agent  ─────▶ │  Project folder (index.html, compositions/,   │
                         │  assets/, framecraft.json, transcript.json)    │
                         └───────────────┬──────────────────────────────┘
                                         │
         ┌───────────────────────────────┼───────────────────────────────────┐
         │                               │                                   │
   ┌─────▼──────┐                 ┌──────▼───────┐                    ┌──────▼──────┐
   │  lint      │                 │ studio-server│◀──── HTTP/WS ────▶ │  Studio UI  │
   │ (static)   │                 │ (Hono, local)│                    │ (React app) │
   └─────┬──────┘                 └──────┬───────┘                    └──────┬──────┘
         │                               │ serves project + injects runtime  │ embeds
         │                        ┌──────▼───────┐                    ┌──────▼──────┐
         │                        │  runtime     │◀── postMessage ───▶│  player     │
         │                        │ (in iframe)  │                    │ (<fc-player>)│
         │                        └──────────────┘                    └─────────────┘
         │
   ┌─────▼─────────────────────────────────────────────────────────────────────┐
   │ producer: compile → probe media → extract video frames → capture (engine) │
   │           → encode (FFmpeg) → mix audio (FFmpeg) → mux → output            │
   └─────┬─────────────────────────────────────────────────────────────────────┘
         │ used by
   ┌─────▼──────┐   ┌──────────────┐   ┌───────────────┐   ┌────────────────┐
   │   CLI      │   │ render-worker│   │ desktop app   │   │ agent (tools)  │
   └────────────┘   │ (cloud)      │   │ (Electron)    │   └────────────────┘
                    └──────────────┘   └───────────────┘
```

## 4. Tech stack (decided — do not re-litigate)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x strict | |
| Node | >= 22 | uses native `fetch`, `fs/promises`, `worker_threads` |
| Monorepo | pnpm workspaces + Turborepo (`turbo.json`) | `pnpm build` = `turbo run build` |
| Browser automation | `puppeteer-core` + `@puppeteer/browsers` | pin a Chrome-for-Testing version for `chrome-headless-shell` in `packages/engine/src/chromeVersion.ts` |
| Video/audio | FFmpeg + ffprobe (system binary; desktop bundles its own) | minimum FFmpeg 6 |
| HTTP servers | Hono + `@hono/node-server` | studio-server, producer server, cloud API |
| CLI framework | `citty` | lazy-load each command module |
| HTML parsing (Node) | `parse5` (positions) + `linkedom` (DOM API) | parse5 for lint (line/col), linkedom for transforms |
| JS parsing | `acorn` + `acorn-walk`, edits via `magic-string` | lint rules, GSAP script editing |
| CSS parsing | `css-tree` | lint, scoping, font extraction |
| Fonts | `fontkit` | subsetting/metrics; Google Fonts localized to woff2 |
| Images | `sharp` | thumbnails, contact sheets, HEIC → PNG |
| Code animation lib | GSAP 3 (vendored copy served locally, never CDN at render; keep its license/branding headers intact) | used by authors and the AI agent writing code. See `12-CLOUD-PLATFORM.md §9` |
| Visual (Studio-authored) animation | `data-fc-motion` attribute → browser-native Web Animations API (no GSAP) | everything Studio's no-code animation UI creates. See `01 §6b`, `02 §5` |
| Studio UI | React 19, Vite 6, Tailwind v4, zustand, dockview-react, CodeMirror 6, @tanstack/react-virtual | |
| Desktop | Electron (latest stable) + electron-builder + electron-updater | |
| Cloud API | Hono on Node, Postgres (Supabase-compatible), Drizzle ORM | |
| Queue | BullMQ on Redis | |
| Object storage | S3-compatible (Cloudflare R2 default) | |
| Render workers | Docker image (Debian slim + chrome-headless-shell + ffmpeg + fonts) on any container platform (Fly.io / Cloud Run / k8s) | |
| Payments | Stripe (subscriptions + metered usage) | |
| Transcription | whisper.cpp CLI (local), optional cloud provider | |
| Background removal | `onnxruntime-node` + RMBG/U²-Net ONNX model | |
| LLM | Anthropic Claude via provider interface (OpenAI optional) | |
| Unit tests | vitest | |
| E2E | Playwright | |
| Lint/format | Biome | |

## 5. Repository layout

```
.
├── AGENTS.md
├── NOTICE                       # attributions (Apache-2.0 derived snippets, fonts, models)
├── LICENSE                      # our license (decide: Apache-2.0 for OSS core, proprietary for cloud/desktop)
├── package.json  pnpm-workspace.yaml  turbo.json  biome.json  tsconfig.base.json
├── plan/                        # this plan
├── packages/
│   ├── contract/                # names, types, attribute constants, timing compiler, HTML/clip parser, schema
│   ├── runtime/                 # browser IIFE injected into compositions (clock, seek, adapters, media, bridge)
│   ├── engine/                  # chrome mgmt, frame capture, video frame extraction, encoders, audio mixer, parallel
│   ├── producer/                # compile pipeline + render job orchestration + HTTP render server
│   ├── player/                  # <fc-player> web component
│   ├── lint/                    # static lint rules + browser "check" gate
│   ├── media/                   # transcribe, tts, bg removal, beats, silence, analyzers, captions generator
│   ├── registry-client/         # search/install blocks + components; framecraft.json handling
│   ├── agent/                   # LLM agent loop, tool definitions, skills loader
│   ├── studio-server/           # local API for Studio (files, mutations, media, render, history)
│   ├── studio/                  # React editor app
│   ├── sdk/                     # programmatic API: open project, edit elements, render (used by agent/studio)
│   └── cli/                     # framecraft CLI
├── apps/
│   ├── desktop/                 # Electron shell around studio + studio-server
│   ├── api/                     # cloud backend
│   ├── render-worker/           # cloud render worker (Docker)
│   └── web/                     # marketing site, catalog site, share pages (/v/:id), account dashboard
├── registry/
│   ├── blocks/<name>/{<name>.html, registry-item.json, preview.mp4, README.md}
│   ├── components/<name>/...
│   ├── examples/<name>/...      # starter project templates used by `framecraft init --template`
│   └── registry.json            # generated index
├── skills/                      # agent skills (SKILL.md + references/)
├── fixtures/                    # test compositions + golden frames
└── docs/                        # user + developer docs
```

## 6. Package dependency graph (no cycles allowed)

```
contract  ◀─ runtime (bundles contract's browser-safe parts)
contract  ◀─ lint ◀─ (uses runtime bundle for browser check)
contract  ◀─ engine ◀─ producer ◀─ cli
runtime   ◀─ producer (injects built IIFE)  ◀─ studio-server ◀─ cli
player    ◀─ studio
media     ◀─ producer (probe), cli, studio-server, agent
registry-client ◀─ cli, studio-server, agent
sdk (contract, lint, producer) ◀─ agent ◀─ studio-server
```

## 7. Milestones (detailed tasks in `16-BUILD-ORDER.md`)

| Milestone | Result | Demo that proves it |
|---|---|---|
| **M0 Scaffold** | monorepo, CI, names, doctor | `pnpm build && pnpm test` green in CI |
| **M1 Render loop** | HTML + paused GSAP → MP4 | 5s 1920x1080 30fps fixture renders, identical hash on 2 runs (Linux) |
| **M2 Contract + runtime** | timing, clips, sub-compositions, variables, adapters | all `fixtures/contract/*` render correct golden frames |
| **M3 Media** | video frames, audio mix, fonts, images | talking-head fixture with music + captions renders with A/V sync < 1 frame |
| **M4 Player + preview + check** | live preview, `check`, `snapshot` | `framecraft preview` live-reloads; `check` catches seeded errors |
| **M5 Performance & robustness** | parallel workers, streaming encode, caching, fallbacks | 60s 1080p render ≥ 3× faster than single worker; failure recovery tests pass |
| **M6 CLI complete + formats** | all CLI commands, all output formats | CLI command matrix test passes |
| **M7 Media AI** | transcribe, captions, TTS, bg removal, beats, silence | "caption this clip" pipeline end-to-end |
| **M8 Skills + agent** | skills pack + agent loop with tools | agent produces a passing 15s promo from a brief in fixture eval |
| **M9 Registry** | 40+ first-party blocks, add/catalog, hosted index | `framecraft add lower-third-clean` wires and renders |
| **M10 Studio** | full editor | Playwright suite: select/move/resize/trim/split/undo/render |
| **M11 Cloud** | accounts, cloud render, share, billing | CLI `framecraft cloud render` returns a share URL |
| **M12 Desktop** | signed installers, auto-update | fresh Mac: download → open → render without terminal |
| **M13 Differentiators** | transcript editing, auto-reframe, Style Bible, incremental render | feature acceptance tests in `14-DIFFERENTIATORS.md` |

## 8. Glossary

- **Composition** — an HTML element with `data-composition-id`; the root composition is the project's `index.html`.
- **Sub-composition** — a composition mounted inside another, inline or via `data-composition-src`.
- **Clip** — any timed element (has `data-start`).
- **Track** — editor lane (`data-track-index`); display only, never affects render or z-order.
- **Block** — a registry item that is a full sub-composition scene.
- **Component** — a registry item that is a snippet/effect merged into an existing composition.
- **Adapter** — runtime plugin that seeks one animation library to time `t`.
- **Render mode** — the runtime running inside the producer (determinism shims on, media replaced by frames).
- **Preview mode** — the runtime running in the player/Studio (real-time playback).
