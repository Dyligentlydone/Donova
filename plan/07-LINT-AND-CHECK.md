# 07 — Lint & Check (`@donova/lint`)

Two layers:
1. **lint** — static analysis of HTML/CSS/JS (fast, no browser). Runs in CLI, Studio (on
   save), agent loop, and as producer gate.
2. **check** — lint + a headless browser pass that actually loads and seeks the
   composition and inspects real pixels/layout.

These are what make AI authoring reliable: the agent writes, `check` reports precise,
actionable findings, the agent fixes. Every finding must say **what**, **where**
(file:line:col + element id), **why it matters**, and **how to fix**.

## 1. Engine

```ts
interface LintRule {
  id: string;                       // snake_case, stable forever
  severity: "error" | "warning" | "info";
  category: "structure" | "contract" | "css" | "script" | "gsap" | "media" | "captions" | "audio" | "perf" | "a11y";
  docs: string;                     // docs URL slug
  check(ctx: LintContext): Finding[];
  fix?(ctx: LintContext, f: Finding): TextEdit[];   // for --fix
}
interface LintContext {
  project: ProjectModel;            // from contract.parseProject
  file: string; html: string;
  dom: ParsedComposition;           // parse5 tree with positions
  styles: CssAst[];                 // css-tree per <style>/linked css
  scripts: { ast: AcornProgram; source: string; offset: Position }[];
  compiled?: CompiledComposition;   // timing (with probe if available)
  gsap: GsapCallIndex;              // extracted tl.to/from/fromTo/set calls (§3)
}
interface Finding { ruleId; severity; message; hint; file; line; col; endLine?; endCol?; elementId?; data?: unknown }
```

Config in `donova.json` → `"lint": { "rules": { "<id>": "off"|"warning"|"error" } }`.
Inline disable: `<!-- donova-lint-disable rule_id -->` before an element.

## 2. Rule set (implement all; grouped; severity in brackets)

### Structure & timing
- `root_missing_composition_id` [error] — no `[data-composition-id]` root.
- `root_missing_dimensions` [error] — no `data-width`/`data-height`.
- `root_missing_duration_source` [warning] — no `data-duration` and duration had to be derived.
- `duplicate_composition_id` [error]
- `timeline_element_missing_timing` [error] — clip-looking element (`class=clip`) without `data-start`.
- `timed_element_missing_clip_class` [warning] (fixable)
- `missing_element_id` [error] — timed element without `id`.
- `duplicate_element_id` [error]
- `timing_reference_unknown` [error] — `data-start="foo"` where `#foo` not in composition.
- `timing_cycle` [error]
- `missing_duration` [error] — DOM clip / sub-comp host without duration.
- `clip_ends_past_root_duration` [warning]
- `nested_clip_never_visible` [warning] — child window falls outside host window.
- `deprecated_data_end`, `deprecated_data_layer` [error] (fixable)
- `invalid_parent_traversal_in_asset_path` [error] — `../` in asset paths.
- `subcomposition_missing_template` / `standalone_composition_wrapped_in_template` [error]
- `subcomposition_style_unscoped` [error] — selectors in a sub-comp not prefixed by `[data-composition-id="id"]` (fixable: auto-prefix).
- `timeline_track_too_dense` [info] — > 30 clips in one track.
- `missing_data_no_timeline` [warning] — composition has no script registering a timeline and no `data-no-timeline`.

### Scripts & determinism
- `non_deterministic_code` [error] — `Math.random()` (unseeded libraries ok), `Date.now`, `new Date()`, `performance.now`, `crypto.getRandomValues` used in timeline-affecting code. (Runtime shims them anyway, but authors must not rely on wall time.)
- `requestanimationframe_in_composition` [warning]
- `network_fetch_in_composition` [warning] — `fetch(`/XHR to remote URLs (local asset fetch inside `buildReady` ok).
- `missing_timeline_registry` [error] — timeline created but never assigned to `window.__timelines`.
- `timeline_id_mismatch` [error] — `__timelines["x"]` where no composition has id `x`.
- `invalid_inline_script_syntax` [error] — acorn parse failure (report line/col).
- `imperative_media_control` [error] — script calls `.play()`, `.pause()`, sets `.currentTime` on media.
- `script_toggles_clip_visibility` [warning] — script sets display/visibility on clip elements.

### GSAP
- `missing_gsap_script` [error] — `gsap.` used but no gsap script loaded.
- `missing_gsap_plugin` [error] — uses SplitText/MotionPath/etc. without registering plugin.
- `gsap_timeline_not_paused` [error] — registered timeline created without `paused: true`.
- `gsap_child_timeline_paused` [error] — child timeline added to root with `paused: true` (won't advance).
- `gsap_infinite_repeat` [error] — `repeat: -1` (non-finite length).
- `gsap_animates_clip_element` [warning] — tween targets a clip element's `display`/`visibility`.
- `gsap_from_opacity_noop` [warning] — `from({opacity:0})` on element already opacity 0.
- `overlapping_gsap_tweens` [warning] — same target + same property overlapping in time on one timeline.
- `gsap_callback_dom_measurement` [warning] — `onUpdate`/`onComplete` callbacks (do not fire reliably on seek).
- `gsap_function_value_hazard` [warning] — function-based values using randomness.
- `gsap_non_transform_motion` [info] — animating `left/top/width/height` (suggest x/y/scale for perf).
- `gsap_timeline_registered_before_async_build` [error] — timeline registered before awaited content exists.

### Declarative motion
- `motion_invalid_json` [error] — `data-fc-motion` is not valid JSON / fails schema.
- `motion_unknown_prop` [error], `motion_unknown_ease` [error]
- `motion_overlap` [warning] — two entries animate the same prop over overlapping times.
- `motion_beyond_clip` [warning] — keys outside the element's clip window.
- `motion_gsap_same_prop` [warning] — `data-fc-motion` and GSAP both animate the same visual channel (e.g. both opacity) on one element.

### CSS
- `css_parse_error` [error]
- `css_transition_used` [warning] — CSS `transition` (time-based, not seekable).
- `negative_z_index` [warning]
- `runtime_hidden_style_opacity` [warning] — element starts `opacity:0` with no tween revealing it.
- `font_not_loaded` [warning] — `font-family` without a matching `@font-face`/link (system fallback risk).
- `root_dimensions_mismatch` [error] — root CSS size ≠ data-width/height.
- `viewport_units_used` [warning] — `vw/vh` inside compositions (depend on viewport, not canvas).

### Media
- `media_missing_id`, `media_missing_src`, `media_missing_data_start` [error]
- `media_file_not_found` [error] — local file missing.
- `video_missing_muted` [error] — `<video>` without `muted` and without `data-has-audio="true"`.
- `video_muted_with_declared_audio` [error]
- `video_audio_double_source` [warning] — video has audio and a separate `<audio>` with the same src overlapping.
- `media_preload_none` [warning]
- `base64_media_prohibited` [error] — `data:` media > 64 KB.
- `placeholder_media_url` [error] — example.com, placeholder.com, lorem picsum in final renders.
- `self_closing_media_tag` [error] — `<video/>`.
- `video_nested_in_timed_element` [warning] — video inside another clip (timing ambiguity) unless inside sub-comp.
- `unsupported_media_format` [error] — probe fails or codec not decodable by ffmpeg.
- `media_trim_exceeds_source` [error] — `mediaStart + duration*rate > source duration` (needs probe).

### Captions
- `multiple_caption_tracks` [error]
- `caption_track_kind_missing` [warning] — caption-looking structure without `data-caption-track`.
- `caption_overflows_safe_zone` [warning] (check-level, needs layout) — see §4.
- `caption_words_overlap_in_time` [error]

### Audio
- `audio_volume_double_automation` [warning] — data-volume animated by GSAP *and* automation lane.
- `audio_fx_invalid` [error] — unknown fx id or param out of range.
- `audio_group_no_members` [warning]

### Perf
- `composition_file_too_large` [warning] — > 2 MB HTML.
- `heavy_filter_usage` [info] — many `backdrop-filter`/`filter: blur` large elements (slow capture).
- `too_many_simultaneous_videos` [warning] — > 6 videos active at once.

## 3. GSAP call index (shared with Studio's GSAP editing)

Walk acorn AST for member calls `X.to|from|fromTo|set|add|call(...)` where `X` resolves to a
`gsap.timeline()` variable (track simple aliases `const tl = gsap.timeline(...)`, chained
calls `tl.to(...).to(...)`). Record: timeline var, registered id, target selector (string
literal or unknown), vars object (literal props with source ranges), position parameter
(number, `"<"`, `">"`, `"+=0.5"`, label), resolved start/end (compute GSAP position rules:
default appends at end; `"<"` = start of previous; `">"` = end of previous; `"+=n"`/`"-=n"`
relative to end; labels). Mark `editable: true` only if target and all props are literals.

## 4. Browser check (`check`)

Runs after lint passes (or with `--force`). Uses the engine in screenshot mode at 0.5×
scale for speed.

1. Load composition, wait ready (timeout → `page_never_ready` error with diagnostics).
2. Collect: console errors, uncaught exceptions, failed requests, runtime diagnostics.
3. Sample times: every 0.5 s, plus each clip start+0.05 and end−0.05, plus 0 and last frame
   (cap `--samples`, default 120).
4. At each sample, evaluate in page and collect:
   - **Overflow**: visible text elements whose bounding box exits the canvas (> 2 px) →
     `text_overflows_canvas` [error]; text clipped by `overflow:hidden` parent (scrollWidth > clientWidth) → `text_clipped` [warning].
   - **Safe zones** (9:16 social): captions/key text inside bottom 18% or top 10% or right 12% → `content_in_platform_ui_zone` [warning]. Zone presets per aspect in `lint/src/safeZones.ts`.
   - **Contrast**: for each visible text node, sample the rendered background behind the
     text box from the screenshot (median of 9 points around glyph box, excluding glyph
     pixels by luminance clustering) and compute WCAG ratio with the text color →
     `low_contrast_text` [warning] if < 4.5 (or < 3 for ≥ 24px bold / ≥ 32px).
   - **Overlap**: two visible text elements intersecting > 20% of the smaller → `text_overlap` [warning].
   - **Blank frame**: screenshot near-uniform (stddev < 2) for > 1 s → `blank_segment` [warning].
   - **Frozen**: no pixel change for > 4 s while no video active → `static_segment` [info].
   - **Off-canvas elements**: clip active but its content entirely off-canvas → `clip_offscreen` [warning].
5. Media: every media element loaded without error; video frame extraction dry-run (probe only).
6. Output: findings + a contact sheet PNG of samples (`renders/.check/contact.png`) whose
   path is printed so agents can view it.

## 5. Acceptance criteria
- Each rule has ≥ 1 positive and ≥ 1 negative fixture test (`lint/fixtures/<rule>/{bad,good}.html`).
- `--fix` rules produce valid output that then passes the rule.
- `check` detects seeded issues in `fixtures/check/*` (overflow, contrast, blank, safe zone) with no false positives on the clean template set.
- Lint of a 300-clip project completes in < 500 ms.
