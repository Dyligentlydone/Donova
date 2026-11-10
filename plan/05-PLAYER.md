# 05 — Player (`@editnce/player`)

An embeddable web component that previews a composition in real time. Used by Studio,
share pages, the catalog site, and docs. Ships as ESM + a global IIFE
(`editnce-player.global.js`).

## 1. Usage

```html
<script src="https://cdn.editnce.dev/player@1/editnce-player.global.js"></script>
<fc-player src="/projects/demo/index.html" controls autoplay muted loop
           poster="/projects/demo/poster.jpg" style="width:540px;aspect-ratio:9/16"></fc-player>
```

Attributes: `src`, `controls`, `autoplay`, `muted`, `loop`, `poster`, `playback-rate`,
`start`, `end` (loop range), `interactive` (pass pointer events to composition),
`fit` (`contain` | `cover`), `video-src` (optional pre-rendered MP4 to play instead of the
live composition — used on share pages for speed, with live fallback).

## 2. Structure

- Shadow DOM: container → `<iframe class="fcp-iframe">` (sandbox `allow-scripts allow-same-origin`, same origin as composition server) → overlay `<div>` (poster, loading, error) → controls bar.
- Iframe is sized to the composition's authored `width×height` and scaled with
  `transform: scale(s)` + centered, where `s = min(hostW/w, hostH/h)` (contain). A
  `ResizeObserver` updates scale.
- Composition dimensions come from the runtime `timeline` message (fallback: fetch HTML
  and read `data-width/height` before load to avoid layout jump).

## 3. JS API (mirrors HTMLMediaElement where sensible)

```ts
class FcPlayer extends HTMLElement {
  play(): Promise<void>; pause(): void; seek(t: number): Promise<void>;
  currentTime: number; readonly duration: number; readonly paused: boolean; readonly ended: boolean;
  playbackRate: number; muted: boolean; volume: number; loop: boolean;
  readonly clips: ClipManifestEntry[]; readonly ready: Promise<void>;
  reload(): void;                                // full iframe reload
  softReload(patch: { css?: string; variables?: Record<string, unknown> }): void;
  enablePickMode(): void; disablePickMode(): void;
  getContentWindow(): Window | null;             // same-origin only (Studio)
}
```
Events (CustomEvent): `ready`, `loadedmetadata`, `play`, `pause`, `seeking`, `seeked`,
`timeupdate` (rAF-throttled), `ended`, `ratechange`, `volumechange`, `error`,
`pick` (detail: element info), `diagnostic`.

## 4. Controls
Play/pause, scrubber with frame-accurate seeking (drag = `seek` throttled to rAF), time
display `mm:ss.ff` and frame number, mute/volume, speed presets (0.25, 0.5, 1, 1.5, 2),
loop toggle, fullscreen. Keyboard: Space, ←/→ (1 frame), Shift+←/→ (1 s), J/K/L, Home/End, M.

## 5. Lifecycle
1. Set `src` → show poster/loader → create iframe → wait runtime `ready` (timeout 45 s → error overlay with diagnostics).
2. Replay state (`set-muted`, `set-volume`, `set-playback-rate`) on every `ready` (iframe reloads reset runtime).
3. `autoplay` waits for `assets-ready`.
4. On `src` change or `reload()`, preserve currentTime and playing state.

## 6. Acceptance criteria
- Playwright: loads fixture, plays 2 s, `timeupdate` advances, pause, seek(1.5) → runtime reports frame 45.
- Resize host → composition stays centered with correct scale.
- Keyboard shortcuts work when focused; no global key capture when unfocused.
- `video-src` mode plays the MP4 and falls back to live iframe on error.
- Global bundle ≤ 60 KB min+gz.
