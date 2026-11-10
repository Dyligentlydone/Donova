# 19 — Frame Annotation ("kinetic frames" equivalent)

Draw on the preview frame, tell the agent what to do. Shipped as a Studio
overlay (injected by `rebrand.ts`, `donova-rebrand-annotate-v1`) plus a
localhost sidecar (`annotate.ts`, studioPort + 1000) that persists marks
into the project.

## Contract: `annotations/<iso-stamp>-<slug>.json` + `.png`

Written on "Send to agent". Agents: check `annotations/` before acting on
edit requests — the PNG is the actual frame at mark time with the drawing
baked in, so you can *see* what the user pointed at.

```json
{
  "v": 1,
  "t": 8.72,
  "comp": { "w": 2160, "h": 3840 },
  "marks": [{ "type": "circle|pen|arrow|rect", "color": "#5df0a0",
              "from": {"x":0.31,"y":0.42}, "to": {"x":0.45,"y":0.51},
              "pts": [{"x":0.3,"y":0.4}, "..."] }],
  "note": "put the text behind this guy",
  "png": "<same-basename>.png"
}
```

- Coordinates are **normalized comp space** (0–1). Multiply by `comp.w/h`
  for pixels — use them directly for `transform-origin`, text placement,
  zoom targets.
- `t` is film time at mark time (best effort — from `__player` or derived
  from the active video's `data-start` + `currentTime`).
- Vocabulary: **circle** = "the thing here" · **arrow** = direction of
  motion/reveal · **rect** = region to zoom/crop/fit · **pen** = freehand
  region or path · the note disambiguates ("zoom here", "text behind this",
  "blur this face").
- After consuming, move files to `annotations/done/` or delete — don't
  re-apply stale marks.

## Architecture

- Overlay discovers the preview iframe, computes the comp rect
  (`[data-width]` root), draws marks on a fixed canvas, maps to normalized
  coords. Frame PNG = base `<video>` frame + strokes reprojected onto video
  pixels. Tools: pen, circle, arrow, rect; 4 colors; undo/clear/Esc.
- Sidecar: `ensureAnnotateServer()` spawns a detached node process per
  project+port, idempotent via `/health`. `fc studio --stop` also stops it.
- The annotation overlay never touches their React tree — fixed-position
  button + canvas, so Studio updates can't break it.
