# 02 — Browser Runtime (`@framecraft/runtime`)

The runtime is a single IIFE (`dist/framecraft.runtime.iife.js`, target ES2020, no
dependencies at runtime) injected into every composition page — in Studio/player preview
**and** in the producer. It is the single source of truth for "what does time `t` look like".

Build also emits `dist/framecraft.runtime.mjs` (for tests) and
`dist/runtime.manifest.json` `{ version, sha256, artifacts }`. The producer verifies the
sha256 before every render.

## 1. Injection

The serving layer (studio-server, producer file server) injects, as the **first** element
of `<head>`:

```html
<script>window.__FC_CONFIG__ = { mode: "preview" | "render", fps: {num,den}, seed: "<compositionId>", variables: {...}, assetBase: "/" };</script>
<script src="/__fc/runtime.js"></script>
```

It must run before author scripts so determinism shims and `__timelines` exist first.

## 2. Globals (stable contract)

```ts
window.__timelines: Record<string, TimelineLike>   // authors register here
window.__fc = {
  version: string,
  mode: "preview" | "render",
  ready: Promise<void>,             // resolves when mounted + timelines registered + assets settled
  renderReady: boolean,             // mirror for CDP polling
  duration: number,                 // resolved root duration (s)
  fps: { num, den },
  // transport (preview)
  play(): void; pause(): void; seek(t: number): Promise<void>;
  currentTime: number; playing: boolean; playbackRate: number; muted: boolean; volume: number;
  // render
  renderSeek(t: number): Promise<void>,   // canonical deterministic seek; awaited by engine
  // composition access
  getClipManifest(): ClipManifestEntry[]; // compiled clips with abs times (for Studio/engine)
  getVariables(): Record<string, unknown>;
  assetUrl(path: string): string;
  onSeek(cb: (t: number) => void | Promise<void>): () => void;  // custom canvas/WebGL hook
  registerAdapter(adapter: RuntimeAdapter): void;
  buildReady: Record<string, Promise<unknown>>; // authors register async setup (e.g. fetch JSON from assets)
  diagnostics(): Diagnostic[];
}
```

## 3. Boot sequence

1. **Shims** (render mode only, installed synchronously before anything):
   - `Math.random` → seeded PRNG (mulberry32 seeded with FNV-1a hash of `seed`).
   - `Date.now()` and `new Date()` (no-arg) → `epoch(2024-01-01T00:00:00Z) + currentTime*1000`.
   - `performance.now()` → `currentTime * 1000`.
   - `requestAnimationFrame(cb)` → queued; flushed once per `renderSeek` with `performance.now()` value; lint warns on authored rAF anyway.
   - `setTimeout/setInterval` → allowed during boot; after `ready`, callbacks only run when their virtual due time ≤ currentTime (virtual timer queue advanced on each seek).
   - Block network after `ready`: wrap `fetch`/`XMLHttpRequest` to reject with `E_RENDER_NETWORK` (and log diagnostic).
2. **Find root**: `[data-composition-id][data-root="true"]` else first `[data-composition-id]`.
3. **Mount sub-compositions** (depth-first, sequential to keep script order deterministic):
   - For each host with `data-composition-src`: `fetch(assetUrl(src))`, parse with
     `DOMParser`, take the `<template>` content (or `<body>` for full documents), clone,
     assign instance ID, append into host.
   - Rewrite relative `src`/`href`/`poster`/CSS `url()` inside the mounted fragment to be
     relative to the sub-composition file location → project-root URLs.
   - Apply variable bindings (`data-bind-*`).
   - Execute its `<script>` elements in document order by re-creating them (inline: copy
     text; external: set src and await load). Set `__fc._currentInstance` during execution
     so `getVariables()` returns the right values.
   - Await any `__fc.buildReady[*]` promises registered by the instance.
4. **Compile timing** with `@framecraft/contract` browser build. Media durations come from
   `loadedmetadata` (preview) or from `__FC_CONFIG__.probe` (render; producer injects
   probed durations so no media is loaded in render mode).
5. **Wait for timelines**: each composition must register `window.__timelines[id]` unless
   `data-no-timeline`. Poll each animation frame up to `playerReadyTimeout` (default 45 s);
   on timeout record diagnostic `E_TIMELINE_NOT_REGISTERED` and continue.
6. **Pause all timelines** (`tl.pause()`), detect adapters (§5).
7. **Assets settle**: `document.fonts.ready`; all `<img>` in clips active at t=0 decoded
   (`img.decode()`); (preview) media `readyState >= HAVE_FUTURE_DATA` for clips active at t=0.
8. `seek(0)`, set `renderReady = true`, resolve `ready`, post `{type:"ready"}` to parent.

## 4. Seek algorithm (`renderSeek(t)` and preview `seek(t)`)

```
renderSeek(t):
  t = quantize(t)                      // snap to nearest frame time: round(t*num/den)*den/num
  currentTime = t
  advance virtual timers to t
  for each composition instance C (root first, then depth-first):
     localT = C.isRoot ? t : (t - C.hostAbsStart) * C.hostRate + C.hostPlaybackStart
     C.active = C.isRoot || (C.hostAbsStart <= t < C.hostAbsEnd)
  for each clip K: setVisible(K, K.absStart <= t < K.absEnd && parentActive)
  for each adapter A: await A.seek(t, instances)    // GSAP, CSS/WAAPI, Lottie, Anime, Three, custom onSeek
  media step (preview: sync elements; render: set frame image src) (§6)
  flush rAF queue once
  await newly visible <img> decode()
  await all pending buildReady / adapter promises
  // return; engine captures after this resolves
```

Visibility: toggle class `__fc-hidden` (`visibility: hidden !important`) — never touch
`display` or `opacity` (authors animate those). Inactive sub-composition hosts also get
`__fc-hidden`. Clips must keep layout when hidden so measurements are stable.

End boundary: a clip is visible on `[start, end)`. The last frame of the root (t = duration - 1/fps) is always rendered; `t >= duration` is clamped.

## 5. Adapters

```ts
interface RuntimeAdapter {
  id: string;
  detect(): boolean;                                   // is the library present/used?
  init?(ctx: AdapterContext): void | Promise<void>;
  seek(t: number, ctx: AdapterContext): void | Promise<void>;
  durationHint?(): number | null;                      // for derived duration
  destroy?(): void;
}
```

Built-in adapters (each in its own file, each with unit tests against a fake library and
an integration fixture):

| Adapter | Detection | Seek implementation |
|---|---|---|
| `gsap` | `window.gsap` and any `__timelines` entry | For each registered timeline of instance C: `tl.totalTime(localT_C, true)` (suppressEvents). **Same-time ordering fix**: if `localT > ε` first `totalTime(localT - ε, true)` then `totalTime(localT, true)` with ε = 1e-4, so `set()`/zero-duration tweens at exactly `localT` apply in authored order and `from()` tweens initialize. Clamp to `[0, tl.totalDuration()]`. Never call `play()`. |
| `waapi-css` | `document.getAnimations` exists | On init: `document.getAnimations().forEach(a => a.pause())`. On seek: for each animation, `a.currentTime = localT_of_owner * 1000` (owner = composition containing the target). Re-scan animations each seek (new ones appear when classes change). CSS transitions: lint discourages; adapter finishes them instantly (`a.finish()`). |
| `lottie` | `window.lottie` / `bodymovin`, or `<lottie-player>` | Authors register `window.__fc.lottie(name, anim)` or adapter finds `lottie.getRegisteredAnimations()`; seek: `anim.goToAndStop(localT * anim.frameRate, true)`. |
| `animejs` | `window.anime` | Authors register instances on `window.__fc.anime(instance)`; seek: `instance.seek(localT * 1000)` (v3) / `instance.seek(localT*1000)` v4; pause on init. |
| `three` | `window.THREE` | Authors call `window.__fc.three({ renderer, scene, camera, update(t) })`; seek: `update(localT)` then `renderer.render(scene, camera)`. Set `preserveDrawingBuffer: true` lint hint. |
| `motion` | any `[data-fc-motion]` element | At boot: parse each element's JSON (01 §6b), apply text splitting, then `el.animate(keyframes, { duration, easing, fill: "both" })` per keyframe segment and immediately `pause()` it. On seek: set `anim.currentTime = (localT_of_element_clip - segmentStart) * 1000` (clamped). Re-parse when Studio sends `apply-patch` for that element. No GSAP involved. |
| `custom` | `onSeek` registrations | `await cb(localT)` for each registration, in registration order. |
| `canvas2d` | (covered by custom) | — |

`localT` is per composition instance; adapters receive a helper `ctx.localTimeOf(element)`.

## 6. Media

### 6.1 Preview mode
- Each `<video>`/`<audio>` clip is controlled only by the runtime (authors must not call
  play/pause/currentTime — lint `imperative_media_control`).
- When transport is playing and clip active: `el.playbackRate = rate`, `el.play()`; target
  media time `mt = mediaStart + (t - absStart) * rate` (or rate-lane integral). If
  `|el.currentTime - mt| > 0.15` → set `el.currentTime = mt` (drift correction). Check every rAF.
- When paused / seeking: `el.pause(); el.currentTime = mt` and await `seeked` (timeout 2 s).
- Inactive: `el.pause()`.
- Volume in preview: route each element through Web Audio (`MediaElementAudioSourceNode` →
  gain (volume × fades × automation at t) → fx chain nodes → master gain → destination)
  so preview matches the render mix. Master meter exposed at `__fc.audioMeter`.
- Images in far-future clips are lazy: set `src` only when within 5 s of becoming active.

### 6.2 Render mode
- The producer compiles every `<video>` into a frame host (see 04-PRODUCER §3.5):
  `<img data-fc-video-frame data-fc-video-id="talk" ...same id/class/style>`.
  The runtime, on `renderSeek`, computes the frame index for each active video
  (`floor((mediaTime) * videoExtractFps + 1e-6)`) and sets `img.src` to
  `/__fc/frames/<videoId>/<index>.jpg`, then awaits `img.decode()`. (The engine may
  instead inject frames via CDP for speed — see 03-ENGINE §5; the runtime path is the
  reference implementation and must always work.)
- `<audio>` elements are removed from the DOM in render mode (mixer handles them).

## 7. Clock in preview

- `play()`: record `startWall = performance.now()` (real, unshimmed) and `startT`;
  each rAF: `t = startT + (now - startWall)/1000 * playbackRate`; call the internal
  `seekVisual(t)` (same as §4 but media uses play-sync and no awaits on decode).
- At `t >= duration`: if `loop` → seek(loopStart) and continue; else pause at
  last frame and post `ended: true`.
- `pause()` snaps to the nearest frame.

## 8. Parent bridge (postMessage)

Host → runtime (`{ source: "fc-parent", type: "control", action, ... }`):
`play`, `pause`, `seek {time}`, `set-muted {muted}`, `set-volume {volume}`,
`set-playback-rate {rate}`, `set-loop {start, end}`, `enable-pick-mode`,
`disable-pick-mode`, `highlight {elementId}`, `reload-styles {css}`,
`apply-variables {values}`.

Runtime → host (`{ source: "fc-runtime", type, ... }`):
- `ready` (on every load) — host replays mute/volume/rate state.
- `state` `{ currentTime, frame, playing, ended, duration }` — throttled to every rAF while playing, immediate on seek.
- `timeline` `{ clips: ClipManifestEntry[], duration, assetsReady }` — on load and after any timing change.
- `assets-ready` — once.
- `pick` `{ elementId, compositionId, rect, path }` — in pick mode when user clicks/hover.
- `error` / `diagnostic` `{ code, message, elementId? }`.

Validate every inbound message shape; ignore unknown `source`. Only accept messages
from `window.parent`.

## 9. Pick mode (for Studio)
When enabled, the runtime adds capture-phase pointer listeners on the document, finds the
nearest ancestor with an `id` that is either a clip or a descendant of a clip, and posts
`pick` with its bounding rect in composition pixel space (account for root scale). It
never draws inside the composition; Studio draws overlays in its own document.

## 10. Diagnostics
Collect: uncaught errors (`window.onerror`, `unhandledrejection`), timeline not
registered, media load failures, network attempts in render mode, rAF usage, fonts that
failed to load (`document.fonts` `loadingerror`). Expose via `__fc.diagnostics()` and post
to parent.

## 11. Acceptance criteria
- Unit (happy-dom) tests: timing → visibility at boundaries, nested local time, quantization.
- Adapter tests with real GSAP, Lottie, anime.js, three.js in headless Chrome fixtures:
  seeking frames in order `[0, 90, 30, 90, 149, 0]` yields identical pixels for same frame (hash).
- Determinism shims: a fixture using `Math.random`, `Date.now`, `setTimeout` renders identically twice.
- Bridge: Playwright test drives play/pause/seek via postMessage and receives `state`.
- Bundle size ≤ 120 KB minified (excluding optional adapters loaded lazily).
