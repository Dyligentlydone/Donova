---
name: donova-core
description: Donova composition contract — how to author renderable HTML videos. Read before creating or editing any composition.
---

# Donova composition contract

A composition is a static HTML file rendered frame-by-frame into video.

## Root
```html
<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="5" data-fps="30">
```
- `data-composition-id`, `data-width`, `data-height`, `data-duration` (seconds) required.
- `data-fps` optional (default 30).

## Timed elements
- `data-start` (seconds) marks a timed element. Duration via `data-duration` or `data-end`.
- Visual timed elements get `class="clip"` (full-frame box convention).
- `data-track-index` is a display lane only; the renderer ignores it.
- `data-fade-in` / `data-fade-out` (seconds) apply simple opacity fades.

## Animation
- **GSAP (code path)**: load `gsap.min.js`, register ONE paused root timeline:
  ```js
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = gsap.timeline({ paused: true });
  ```
  Child timelines added to the root must not themselves be paused.
- **data-do-motion (declarative path)**: Studio-safe JSON motion on the element:
  ```json
  {"v":1,"split":"words","stagger":0.05,"anims":[{"t":0,"dur":0.6,"ease":"power2.out","props":{"opacity":[0,1],"translateY":["0.5em","0em"]}}]}
  ```
  `t` is seconds relative to the element's data-start. Easings: power1-4/sine/expo/circ/back/elastic/bounce + in|out|inOut.

## Media
- `<video>`: `muted` + `data-has-audio="false"` for silent b-roll; keep audio with `data-has-audio="true"` (no muted).
- `<audio>` elements inherit their clip's window; `data-audio-offset` shifts the start, `data-volume`, `data-audio-fade-in/out` shape it.
- Videos are frame-extracted at render fps — always visible-frame-accurate.

## Sub-compositions
`data-composition-src="compositions/file.html"` + `data-composition-id` on a timed element embeds another composition. Its timeline is offset by the clip start; `data-speed` rescales; `data-clip-absolute="true"` pins absolute seconds. Imported sub-comps keep their own scripts/styles (scoped to the host); GSAP-timeline blocks register `window.__timelines` and are seeked on their local clock.

## Studio-only features (grade, blur, audio bus, FX)
Studio can write `data-color-grading`, `data-motion-blur`, `data-audio-group` / `<hf-audio-group>`, `data-automation`, `data-fx-chain`, `data-vfx-chain`, `data-playback-start`, `data-lottie-src`. These are valid — authoring them is fine — but they render through the hyperframes engine, which `donova render` selects automatically when present (`do check` reports it). Don't strip them to "fix" a check; the routing exists so preview and render match.

## Determinism rules (enforced by lint)
- No `Date.now()`, `new Date()`, `Math.random()` (unseeded), runtime `fetch()` to remote URLs, `setInterval`, or wall-clock rAF.
- All assets local or bundled; fonts via local files.
- `renderSeek(t)` must reproduce the exact frame for any t, in either direction.

## Commands
- `donova check` — lint + headless browser gate. Run after every edit.
- `donova preview` — local scrub preview.
- `donova render --out out.mp4 [--workers N]` — render.
