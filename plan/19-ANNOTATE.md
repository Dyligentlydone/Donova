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
  project+port, idempotent via `/health` (versioned — stale sidecars get a
  `/stop` then respawn). `fc studio --stop` also stops it.
- The annotation overlay never touches their React tree — the Annotate tab
  is a Dockview clone with capture-phase event swallowing, the draw canvas
  is scoped to the comp rect, and the chat panel is fixed-position.

## Agent bridge (`/agent/*`)

- `GET /agent/health` → `{agent, name, cmd, edits}`.
- `GET /agent/list` → `{agents: [{name, label, detected, active}]}` — feeds
  the chat panel's agent picker.
- `POST /agent/select {name}` → switches the active agent (preset name),
  persists the choice as `"agent": "<name>"` in `framecraft.json`.
- Agent resolution order: session select → `framecraft.json` `agent` →
  `FC_AGENT` env → `FC_AGENT_CMD` env → `FC_AGENT_URL`/`FC_AGENT_MODEL` →
  first detected preset on PATH → no bridge (503 → file-drop fallback).
- `framecraft.json` `agent` accepts:
  - `"auto"` — force auto-detect (default when absent)
  - `"<preset>"` — `claude` | `codex` | `gemini` | `opencode` | `aider`
  - `{ "cmd": "any cli --flags {prompt}" }` — custom agent command;
    `{prompt}` substitutes as an arg, otherwise the prompt goes to stdin
  - `{ "url": "http://…/v1/chat/completions", "model": "…", "keyEnv": "…" }` —
    any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, …).
    Reply-only (`edits:false`) — it can discuss the edit but can't modify
    files; `keyEnv` names an env var holding the bearer key.
- `POST /agent/chat {message, annotation?}` → `{jobId, name, cmd, edits}` —
  runs the resolved agent in the project dir, broadcasts output to SSE
  listeners. Preset headless cmds: `claude -p --dangerously-skip-permissions`,
  `codex exec --dangerously-bypass-approvals-and-sandbox "{prompt}"`,
  `gemini --yolo -p "{prompt}"`, `opencode run "{prompt}"`,
  `aider --yes-always --message "{prompt}"`.
- `GET /agent/jobs/:id/stream` → SSE replay + live chunks + `done` event.
- `GET /file?p=annotations/x.png` → thumbnail service for chat cards.
- Chat panel (`donova-rebrand-chat-v1` inject): collapsible agent window
  with an agent-picker dropdown in the header; the annotate overlay's
  "Send to agent" routes through `window.__fcChat` — the annotation
  attaches as a card + the run streams live in-thread.
- Same contract will be implemented by `apps/api` for hosted mode
  (plan/12) — UI is backend-agnostic.
