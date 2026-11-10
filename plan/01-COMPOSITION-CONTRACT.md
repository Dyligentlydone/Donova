# 01 — Composition Contract (`@donova/contract`)

The contract is the public file format. Everything (runtime, lint, producer, Studio,
agent, registry) reads it through this package. Changing it is a breaking change.

## 1. Project folder

```
my-video/
├── index.html              # root composition (required)
├── compositions/           # sub-compositions (*.html)
├── assets/                 # media: video, audio, images, fonts, lottie json
├── donova.json         # project config (see §9)
├── meta.json               # { id, name, createdAt } (id = uuid, stable)
├── transcript.json         # optional, word-level transcript (see 10-MEDIA-AI §2)
├── style.json              # optional, Style Bible tokens (see 14-DIFFERENTIATORS §3)
├── AGENTS.md / CLAUDE.md   # scaffolded agent instructions (identical files)
└── renders/                # output (gitignored)
```

Paths inside compositions resolve **relative to the project root**, never with `../`.

## 2. Root composition

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="assets/fonts.css">
  <style>
    html, body { margin: 0; }
    .clip { position: absolute; inset: 0; }
  </style>
</head>
<body>
  <div id="root"
       data-composition-id="main"
       data-root="true"
       data-start="0"
       data-width="1080" data-height="1920"
       data-duration="12"
       data-fps="30">
    <video id="talk" src="assets/talk.mp4" data-start="0" data-duration="12"
           data-has-audio="true" data-track-index="0"></video>
    <section id="title" class="clip" data-start="0.5" data-duration="3" data-track-index="1">
      <h1>Hello</h1>
    </section>
    <audio id="music" src="assets/music.mp3" data-start="0" data-duration="12"
           data-volume="0.25" data-fade-in="1" data-fade-out="2" data-track-index="5"></audio>
  </div>
  <script src="vendor/gsap.min.js"></script>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.from("#title h1", { y: 60, opacity: 0, duration: 0.6, ease: "power3.out" }, 0.5);
    window.__timelines["main"] = tl;
  </script>
</body>
</html>
```

## 3. Attributes — composition root (`[data-composition-id]`)

| Attribute | Required | Type | Meaning |
|---|---|---|---|
| `data-composition-id` | yes | string, `[a-z0-9-_]+`, unique in project | Identity; key in `window.__timelines` |
| `data-root="true"` | root only | flag | Marks the top-level composition when multiple exist in a document |
| `data-start` | root: yes (`0`) | timing expr | Start on parent timeline |
| `data-width`, `data-height` | yes | int px | Authored canvas size |
| `data-duration` | strongly recommended | seconds | Total length. If absent: max(clip ends, timeline duration) — lint warns |
| `data-fps` | no (default 30) | int or rational `30000/1001` | Frame rate; CLI `--fps` overrides |
| `data-no-timeline` | when no JS timeline | flag | Do not wait for a timeline registration |
| `data-composition-variables` | sub-comps | JSON array of variable decls (§7) | Declares editable variables |
| `data-background` | no | CSS color | Stage background; producer paints it under everything (prevents white flashes) |

## 4. Attributes — clips (any timed element)

| Attribute | Applies to | Type | Meaning |
|---|---|---|---|
| `id` | all clips | string | **Required**, unique per composition. Stable handle for editing/animation |
| `data-start` | all clips | timing expr (§5) | Start time on the parent composition's local timeline |
| `data-duration` | DOM clips, sub-comp hosts: required; `img`: default 3; `video`/`audio`: default source length | seconds > 0 | Slot length |
| `data-track-index` | all | int ≥ 0 | Editor lane only. Render ignores it. Not z-order |
| `class="clip"` | DOM + img clips | | Convention: full-frame box via shared CSS. Lint warns if missing |
| `data-media-start` | video, audio | seconds ≥ 0 | Offset into the source file (trim). Canonical for media |
| `data-playback-start` | sub-comp host | seconds ≥ 0 | Offset into the child timeline. Canonical for sub-comps |
| `data-playback-rate` | video, audio, sub-comp | 0.1–10 | Speed multiplier |
| `data-volume` | video, audio | 0–3.98 (+12 dB) | Static gain |
| `data-fade-in`, `data-fade-out` | video, audio | seconds | Linear clip-edge gain fades |
| `data-has-audio="true"` | video | flag | Video contributes its audio track to the mix (and must not be `muted`) |
| `data-automation` | video, audio, sub-comp | JSON (§6) | Keyframed lanes: `volume`, `rate` |
| `data-fx-chain` | video, audio, `<fc-audio-group>` | JSON array | Audio effects (see 03-ENGINE §7.5) |
| `data-color-grade` | video, img | JSON | Color grading (exposure, contrast, saturation, temperature, tint, LUT ref) |
| `data-fc-motion` | any element | JSON (§6b) | Declarative keyframe animation (what Studio's visual animation tools write). Runtime turns it into paused Web Animations |
| `data-composition-src` | sub-comp host | project-relative path | External sub-composition file |
| `data-variable-values` | sub-comp host | JSON object | Values for the child's declared variables |
| `data-caption-track="true"` | caption container | flag | Marks the single caption track (Studio + lint) |
| `data-fc-media-start-basis="global"` | nested media | flag | Legacy: media start authored in root time |

Unknown `data-*` attributes are ignored by the runtime and preserved by all editors.

**Deprecated (lint error, auto-fixable):** `data-end` (use duration), `data-layer` (use track-index).

## 5. Timing expressions (`data-start`)

Grammar:

```
expr   := number | ref | ref ws? ("+"|"-") ws? number
number := decimal seconds, e.g. 0, 1.5, 12.25
ref    := id of a sibling clip in the same composition
```

Semantics:
- `"3"` — absolute local time 3 s.
- `"intro"` — start when clip `#intro` ends (`intro.start + intro.duration`).
- `"intro + 0.5"` — 0.5 s gap after intro. `"intro - 0.5"` — 0.5 s overlap.
- References resolve only within the same composition. Referenced clip must have a
  known duration. Cycles are an error (`E_TIMING_CYCLE`).

Implementation (`contract/src/timing/compile.ts`):
1. Collect clips of one composition: `{ id, startExpr, durationAttr, kind }`.
2. Parse each `startExpr` into `{ ref?: string, offset: number }`.
3. Topologically sort by ref dependencies (Kahn). Cycle → throw with the cycle path.
4. Resolve `start = ref ? (refStart + refDuration + offset) : offset`.
5. Duration resolution order: `data-duration` → media: `(sourceDuration - mediaStart) / rate`
   (needs probe; "pending" until known) → `img`: 3 → sub-comp: child's resolved duration
   → DOM clip without duration: error `E_MISSING_DURATION`.
6. Absolute time for nested clips: `absStart = parentAbsStart + (localStart - parentPlaybackStart) / parentRate`.
   Keep both local and absolute in the compiled model.

Output type:

```ts
interface CompiledClip {
  id: string;
  compositionId: string;      // owning composition
  kind: "dom" | "img" | "video" | "audio" | "composition" | "caption";
  localStart: number; duration: number | null;  // null = pending probe
  absStart: number; absEnd: number | null;
  mediaStart: number; playbackRate: number; volume: number;
  fadeIn: number; fadeOut: number;
  trackIndex: number | null;
  src?: string; hasAudio?: boolean;
  automation?: AutomationLanes;
  children?: CompiledClip[];  // for composition hosts
}
interface CompiledComposition {
  id: string; width: number; height: number; fps: Fps; duration: number;
  durationSource: "authored" | "derived-clips" | "derived-timeline";
  clips: CompiledClip[]; variables: VariableDecl[];
}
type Fps = { num: number; den: number }; // 30 => {30,1}; 29.97 => {30000,1001}
```

Frame math everywhere: `frameCount = ceil(duration * num / den)`, `timeOfFrame(i) = i * den / num`.
Never accumulate floating time; always compute from the integer frame index.

## 6. Automation lanes (`data-automation`)

```json
{
  "volume": [{ "t": 0, "v": 1 }, { "t": 2.0, "v": 0.2, "ease": "linear" }, { "t": 5, "v": 1 }],
  "rate":   [{ "t": 0, "v": 1 }, { "t": 1, "v": 2, "ease": "inOut" }]
}
```
- `t` is clip-local seconds. Values interpolate between keys (`linear` | `in` | `out` | `inOut` | `hold`).
- Volume lane multiplies `data-volume` and fades.
- Rate lane (speed ramp): media time = ∫ rate dt; implement with piecewise integration
  (exact for linear segments; numeric with 1 ms steps for eased segments). The same
  integral is used for video frame extraction and audio (`atempo` segments).

## 6b. Declarative motion (`data-fc-motion`)

The no-code animation format. Studio's keyframe editor, drag-to-animate, ease picker and
"Add animation" presets read and write **only** this attribute — never GSAP code (licensing
reason: see 12 §9). It is also a good, simple format for the agent when it wants an
animation to stay editable in Studio.

```html
<h1 id="title" class="clip" data-start="0.5" data-duration="3"
    data-fc-motion='[
      {"prop":"opacity","keys":[{"t":0,"v":0},{"t":0.4,"v":1,"ease":"out-cubic"}]},
      {"prop":"translateY","unit":"px","keys":[{"t":0,"v":40},{"t":0.4,"v":0,"ease":"out-back"}]},
      {"prop":"opacity","keys":[{"t":2.6,"v":1},{"t":3,"v":0,"ease":"in-cubic"}]}
    ]'>Hello</h1>
```

- `t` = seconds relative to the element's clip start (or to its owning composition if the
  element is not itself a clip).
- `prop` ∈ `opacity`, `translateX`, `translateY`, `scale`, `scaleX`, `scaleY`, `rotate` (deg),
  `blur` (px → `filter`), `color`, `backgroundColor`, `borderRadius`, `letterSpacing`,
  `width`, `height`, `clipInset` (`[top,right,bottom,left]` % → `clip-path: inset()`),
  `strokeDashoffset` (SVG draw-on).
- Transforms are written to the **individual** CSS properties `translate`, `scale`, `rotate`,
  so they compose with (never clobber) a GSAP-owned `transform` on the same element.
- `ease` names: `linear`, `in|out|in-out` × `sine|quad|cubic|quart|expo|circ|back`, plus
  `elastic`, `bounce`, `steps(n)`, or a raw `cubic-bezier(...)`. Map back/elastic/bounce to
  CSS `linear(...)` easing with ≥ 30 sample points.
- Text splitting: `{"prop":"opacity","split":"words"|"chars"|"lines","stagger":0.05,"keys":[...]}`.
  The runtime wraps words/chars in `<span class="__fc-split">` once at boot (deterministic,
  before fonts-ready layout measurement for `lines`).
- Multiple entries for the same prop must not overlap in time (lint `motion_overlap`).

## 7. Variables

Declaration on the sub-composition root:

```json
[
  { "id": "title", "type": "string", "label": "Title", "default": "Hello", "maxLength": 60 },
  { "id": "accent", "type": "color", "label": "Accent", "default": "#ff4d4f" },
  { "id": "count", "type": "number", "min": 0, "max": 100, "default": 42 },
  { "id": "logo", "type": "image", "default": "assets/logo.png" },
  { "id": "clip", "type": "video", "default": "assets/broll.mp4" },
  { "id": "style", "type": "enum", "options": ["light", "dark"], "default": "dark" },
  { "id": "show", "type": "boolean", "default": true }
]
```

Values on host: `data-variable-values='{"title":"Pro"}'`. CLI override: `--var title=Pro`
or `--vars vars.json` (applies to root). Precedence: CLI > host values > defaults.

Read in scripts: `const v = window.__fc.getVariables()` (returns values for the
*currently executing* composition instance; runtime sets the instance context while
running that sub-comp's scripts).

Script-free bindings (runtime applies before scripts run):
- `data-bind-text="title"` → `textContent`
- `data-bind-src="logo"` → `src`
- `data-bind-style="--accent:accent"` → CSS custom property
- `data-bind-show="show"` → `hidden` attribute

## 8. Sub-compositions

External file format — content inside a `<template>`:

```html
<template id="lower-third-template">
  <div data-composition-id="lower-third" data-width="1920" data-height="1080" data-duration="4">
    <div class="name"></div>
    <style>[data-composition-id="lower-third"] .name { font: 700 56px Inter; }</style>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.from('[data-composition-id="lower-third"] .name', { x: -80, opacity: 0, duration: 0.5 });
      window.__timelines["lower-third"] = tl;
    </script>
  </div>
</template>
```

Rules:
- One root `[data-composition-id]` per template. Styles must be scoped by
  `[data-composition-id="<id>"]` (lint enforces; Studio/registry install auto-scopes).
- When the same file is mounted twice, the runtime suffixes instance IDs
  (`lower-third`, `lower-third__2`) and registers each timeline under the instance ID;
  the host's `data-composition-id` names the instance.
- Child timing is local to the child. Host `data-playback-start` offsets the child clock.
- A sub-composition file must also be renderable standalone (`render -c compositions/x.html`).

## 9. `donova.json`

```json
{
  "$schema": "https://donova.dev/schema/donova.json",
  "version": 1,
  "entry": "index.html",
  "registry": "https://registry.donova.dev/registry.json",
  "paths": { "blocks": "compositions", "components": "compositions/components", "assets": "assets" },
  "render": { "fps": 30, "quality": "standard", "format": "mp4" },
  "engineVersion": "0.1.0"
}
```

Ship JSON Schemas for `donova.json`, `registry.json`, `registry-item.json`,
`transcript.json`, `style.json` under `packages/contract/schemas/` and publish them.

## 10. Parser API (`contract/src/parse.ts`)

```ts
parseProject(dir): Promise<ProjectModel>        // reads index + all sub-comps
parseCompositionHtml(html, opts): ParsedComposition  // pure, no I/O; keeps source positions
compileTiming(parsed, probe: MediaProbeLookup): CompiledComposition
extractCompositionMetadata(html): { id, width, height, duration, fps, variables }
serializeClipEdit(html, edit: ClipEdit): string  // minimal-diff attribute rewrite (preserve formatting)
```

`ParsedComposition` keeps `sourceRange: {start, end, line, col}` for every element and
attribute so lint can report positions and editors can patch text without reformatting.

## 11. Acceptance criteria

- Unit tests for every row in §3–§8 (parse, compile, error codes).
- Timing: refs, offsets, cycles, pending durations, nested absolute times, rate scaling.
- Round-trip: `serializeClipEdit` changes only the targeted attribute bytes (diff test).
- JSON schemas validate all fixtures and reject 10 invalid samples.
