# 08 — Studio (`@framecraft/studio`) + Studio Server (`@framecraft/studio-server`)

Studio is the visual editor. **The HTML files on disk are the single source of truth.**
Every edit is a minimal text patch to those files, made by studio-server. Studio never
holds a separate document model that can drift; it re-reads the compiled timeline from
the runtime after each save.

## 1. Product editing model (in priority order)
1. **Ask the agent** (chat panel) — primary for non-experts.
2. **Pick & tweak** — click an element in the canvas, adjust in the inspector or drag handles.
3. **Timeline** — move/trim/split clips, audio levels, keyframes.
4. **Code** — full HTML/CSS/JS editor for experts.

## 2. Layout (dockview, persisted per user in localStorage)

```
┌───────────────────────────── Header ───────────────────────────────────────┐
│ project name ▾ | undo redo | aspect ▾ | preview quality ▾ | Check ● | Render │
├──────────┬──────────────────────────────────────────────┬──────────────────┤
│ Left     │              Canvas (player + overlay)        │ Right            │
│ tabs:    │                                               │ tabs:            │
│ Files    │                                               │ Inspector        │
│ Assets   │                                               │ Agent (chat)     │
│ Blocks   │                                               │ Variables        │
│ Layers   │                                               │ Audio            │
│ Captions │                                               │ Color            │
├──────────┴──────────────────────────────────────────────┴──────────────────┤
│ Timeline: ruler | playhead | tracks (video, audio w/ waveform, DOM, comps,   │
│ captions) | zoom | snapping | keyframe lanes for selected element           │
└────────────────────────────────────────────────────────────────────────────┘
```
Code editor opens as a center tab (CodeMirror 6; html/css/js/markdown modes; lint
diagnostics inline from `/api/lint`; format on save with prettier optional).

## 3. Frontend architecture
- React 19 + Vite + Tailwind v4 + zustand stores:
  - `projectStore` (files list, active composition, framecraft.json),
  - `timelineStore` (clip manifest from runtime, zoom, scroll, selection),
  - `playerStore` (time, playing, rate, muted),
  - `selectionStore` (selected element ids, hovered),
  - `historyStore` (server-backed undo/redo stack pointers),
  - `agentStore` (chat threads, tool runs),
  - `renderStore` (queue, progress via SSE).
- The canvas = `<fc-player>` (same origin as studio-server) + an **overlay layer in Studio's
  own DOM** absolutely positioned over the iframe. Selection boxes/handles are measurements
  of iframe elements: `el.getBoundingClientRect()` inside iframe × player scale + iframe offset.
  Never inject UI into the composition document.
- Live data: WebSocket `/api/events` (file changed, lint results, render progress, agent events).

## 4. Canvas interactions
- Hover → outline; click → select (runtime pick mode returns element id). Shift-click multi-select. Esc deselect. Double-click text → inline text edit (contenteditable on the iframe element, commit on blur/Enter, Esc cancels).
**Licensing rule (hard): no Studio UI ever creates, edits, or deletes GSAP code.** Visual
animation work writes `data-fc-motion` (01 §6b) only. GSAP code is edited by the user in the
Code tab or by the AI agent writing code. (See 12 §9.)

- Drag to move: during drag apply a temporary CSS `translate` on the iframe element (no save); on pointer-up commit:
  - **Static mode** (default; "Record keyframes" toggle off) → write a static position into inline style via `patch-element` (`left/top`, or CSS `translate` if the element has GSAP/motion transforms, since individual `translate` composes with `transform`). This is layout, not animation, even on GSAP-animated elements.
  - **Keyframe mode** ("Record keyframes" on) → insert/update a `translateX/translateY` key at the playhead in the element's `data-fc-motion` (`/api/mutations/motion`).
- Resize handles (8) → static `width/height` (static mode) or `scale` keys in `data-fc-motion` (keyframe mode). Shift = keep aspect. Alt = from center.
- Rotate handle → CSS `rotate` property (individual transform; measure carefully).
- Snapping: canvas center lines, edges, other elements' edges/centers, safe-zone guides; 6 px threshold; show guide lines.
- Arrow keys nudge 1 px (Shift 10 px).
- Crop for images/videos: object-position/object-fit + clip-path inset.

## 5. Inspector (selected element)
Sections, shown by element kind:
- **Layout**: x, y, w, h, rotation, opacity, z-index, blend mode.
- **Text**: content, font family (project fonts + Google Fonts search → localize on pick), weight, size, line-height, letter-spacing, color, alignment, text-transform, stroke, shadow.
- **Fill/Border**: background (color/gradient), radius, border, shadow, backdrop blur.
- **Timing**: start, duration, track, (media) trim in/out, speed, (sub-comp) playback-start.
- **Animation** (editable): the element's `data-fc-motion` entries as keyframe rows — add/move/delete keys, value, ease picker with curve preview. "Add animation" presets (fade in, slide up, pop, typewriter, word-by-word, …) insert `motion-preset` registry items (11 §1) as `data-fc-motion` JSON.
- **Code animations** (read-only): GSAP tweens affecting this element (from lint's GSAP call index + runtime introspection) listed with time ranges, plus two buttons: "Open in code" (jumps to the line in the Code tab) and "Ask the agent to change this".
- **Media**: volume, fades, has-audio toggle, color grade quick controls.
- **Variables** (sub-comp host): form generated from `data-composition-variables` types.

All inspector edits debounce 250 ms then save; preview updates via soft reload (§8).

## 6. Timeline
- Virtualized rows (`@tanstack/react-virtual`); tracks from `data-track-index` (clips without → auto-assign display lanes).
- Clip rendering: video = filmstrip thumbnails (`/api/thumbnail`), audio = waveform peaks (`/api/waveform`), DOM = label + color by kind, sub-comp = nested mini-timeline expandable.
- Operations (each = one undoable server mutation):
  - move (drag) → `data-start` (keep relative refs if present: if start was `"intro + 0.5"`, adjust offset),
  - trim left/right → `data-start`/`data-duration` and `data-media-start` / `data-playback-start` (left trim advances media start by Δ×rate),
  - split at playhead (S) → duplicate element with new id `<id>-2`, adjust both,
  - ripple delete, delete, duplicate (Cmd+D), move to track,
  - audio: volume line (drag), fade handles at top corners, keyframe points on volume lane.
- Snapping to playhead, clip edges, beat markers (`beats.json`), transcript word boundaries.
- Playhead scrub = `player.seek` throttled to rAF. Zoom: Cmd+scroll, pinch; fit (Shift+Z).
- Keyboard: Space play, J/K/L, ←/→ frame, I/O set loop range, S split, Delete, Cmd+Z/Shift+Cmd+Z.

## 7. Agent panel
Chat UI bound to the agent (09). Shows tool calls as collapsible steps (read file, edit,
check results, snapshots as thumbnails). "Apply" is automatic (agent edits files via the same
mutation APIs, so undo works per agent turn = one history group). Context chips: selected
element, playhead time, current composition. Model/provider picker; BYO API key in settings.

## 8. Save → reload protocol
- Every write from Studio/agent carries `X-Fc-Write-Token` (uuid). The file watcher (chokidar)
  emits `file-changed {path, token?}`; Studio ignores events for its own tokens and reloads
  for external changes (editor outside Studio, agent CLI).
- Reload strategy after a save:
  1. CSS-only change → `player.softReload({ css })` (runtime replaces `<style>` text).
  2. Attribute/timing change → runtime `apply-patch` message (set attributes on element, recompile timing) — no iframe reload.
  3. Script change or structural change → full iframe reload preserving time + selection.
- Conflict: if file on disk changed since Studio's last read (mtime/hash) and user edits → banner "File changed outside Studio — Reload / Keep mine".

## 9. Undo/redo
Server-side history per project (`.framecraft/history/`): each mutation stores
`{ id, groupId, file, before (full text or diff), after, label, ts }`. Undo applies the
inverse for the whole group. Persistent across restarts; cap 500 entries (prune oldest).
Gesture-level grouping: a drag = one entry; an agent turn = one group.

## 10. Render queue
Header "Render" → dialog (format, quality, resolution, range, output name) → `POST /api/render`.
Panel lists jobs with progress (SSE), cancel, open file, reveal in Finder (desktop), publish.

## 11. Studio server API (Hono, `127.0.0.1` only, CSRF: require `Origin` = studio origin + per-session token)

| Method & path | Purpose |
|---|---|
| `GET /` , `/assets/*` | Studio SPA |
| `GET /p/*` | Project files served with runtime injection for `.html` (preview mode); Range support |
| `GET /__fc/runtime.js`, `/__fc/vendor/*` | runtime + vendored libs |
| `GET /api/project` | framecraft.json, meta, compositions list, file tree |
| `GET /api/files?path=` / `PUT /api/files` `{path, content, baseHash}` | raw read/write (409 on hash mismatch) |
| `POST /api/files/create|rename|delete` | file ops (inside project root only; path traversal guarded) |
| `POST /api/upload` | multipart upload into `assets/` (limit 4 GB, stream to disk) |
| `POST /api/mutations/patch-element` | `{file, elementId, attrs?: {k: v|null}, style?: {prop: v|null}, text?, html?}` minimal-diff patch |
| `POST /api/mutations/batch` | array of the above, atomic |
| `POST /api/mutations/insert-element` / `delete-element` / `duplicate-element` / `move-element` | structural edits |
| `POST /api/mutations/motion` | `{file, elementId, op: "add-key"|"update-key"|"remove-key"|"set-ease"|"apply-preset"|"clear", prop, t, v?, ease?, preset?}` — rewrites only the element's `data-fc-motion` attribute (minimal diff). There is deliberately **no** GSAP mutation endpoint |
| `POST /api/mutations/timing` | move/trim/split/ripple ops (server computes all attribute changes) |
| `GET /api/lint?file=` | lint findings |
| `POST /api/check` | run browser check (streams result) |
| `GET /api/media/probe?path=` | ffprobe info (cached) |
| `GET /api/thumbnail?path=&t=&w=` | JPEG frame (ffmpeg `-ss t -frames:v 1`), cached |
| `GET /api/filmstrip?path=&count=&h=` | sprite sheet for timeline |
| `GET /api/waveform?path=&pps=` | peaks JSON (min/max per bucket, from ffmpeg `-f s16le` decode), cached |
| `GET /api/snapshot?t=` | PNG via engine (exact render pixels) |
| `POST /api/render`, `GET /api/render/:id/events` (SSE), `DELETE /api/render/:id` | render queue |
| `GET /api/history`, `POST /api/history/undo|redo` | history |
| `GET /api/registry/search?q=`, `POST /api/registry/install` | registry |
| `GET /api/fonts/search?q=`, `POST /api/fonts/install` | Google Fonts localize |
| `POST /api/media/transcribe|tts|remove-background|beats|silence` | long jobs → job id + SSE |
| `POST /api/agent/chat` (SSE stream) | agent turns |
| `WS /api/events` | file-changed, lint, jobs |

Patch implementation: parse with parse5 keeping offsets, locate element by `id`, compute
the exact byte ranges for the attribute/style/text to change, splice the string. Style
patches parse the existing `style` attribute with css-tree's declaration list parser and
replace/insert one declaration. Never re-serialize the whole document.

## 12. Acceptance criteria (Playwright e2e on built CLI)
- Open template → select title by click → change text in inspector → file on disk changed only in that text node; preview updated without full reload.
- Drag element (static mode) → inline style left/top saved; undo restores exact bytes.
- Drag a GSAP-animated element (static mode) → CSS `translate` offset saved; GSAP script bytes unchanged (assert); render shows offset applied on top of the GSAP motion.
- Keyframe mode: drag at two playhead times → two `translateY` keys in `data-fc-motion`; render frames at both times show the element at the dragged positions (±2 px).
- Apply "slide up" preset → `data-fc-motion` written; preview and render match (PSNR ≥ 40 dB).
- No Studio action modifies any `<script>` content (test: run every Studio mutation type, diff scripts).
- Timeline: move, trim-left on video (media-start advanced), split, ripple delete → render matches expectation (golden frames).
- External edit of index.html (fs write) → Studio reloads; Studio's own saves never trigger a reload flash.
- Render from dialog → progress → output exists; cancel works.
- Agent panel: scripted fake LLM provider performs an edit → appears as one undo group.
