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
  `/stop` then respawn). `do studio --stop` also stops it.
- The annotation overlay never touches their React tree — the Annotate tab
  is a Dockview clone with capture-phase event swallowing, the draw canvas
  is scoped to the comp rect, and the chat panel is fixed-position.

## Agent bridge (`/agent/*`)

- `GET /agent/health` → `{agent, name, cmd, edits}`.
- `GET /agent/list` → `{agents: [{name, label, kind, detected, active,
  needsKey?, needsModel?, needsUrl?, install?}]}` — feeds the chat panel's
  agent picker. `kind` is `cli` (needs the binary on PATH) or `api`
  (OpenAI-compatible endpoint, configured via the setup form).
- `POST /agent/select {name}` → switches the active agent (preset name),
  persists the choice as `"agent": "<name>"` in `donova.json`.
- `POST /agent/setup {name, key?, url?, model?}` → configures an API
  provider; stored in `~/.donova/agents.json` (mode 600) — keys never
  touch the project or logs.
- Agent resolution order: session select → `donova.json` `agent` →
  `FC_AGENT` env → `FC_AGENT_CMD` env → `FC_AGENT_URL`/`FC_AGENT_MODEL` →
  first detected preset (CLI on PATH, then configured API provider) →
  no bridge (503 → file-drop fallback).
- `donova.json` `agent` accepts:
  - `"auto"` — force auto-detect (default when absent)
  - `"<preset>"` — `claude` | `codex` | `gemini` | `opencode` | `aider` |
    `openai` | `gemini-api` | `openrouter` | `ollama` | `lmstudio` | `custom-api`
  - `{ "cmd": "any cli --flags {prompt}" }` — custom agent command;
    `{prompt}` substitutes as an arg, otherwise the prompt goes to stdin
  - `{ "url": "http://…/v1/chat/completions", "model": "…", "keyEnv": "…" }` —
    any OpenAI-compatible endpoint; `keyEnv` names an env var holding the
    bearer key.
- API agents run a **tool-call loop** (`read_file`, `write_file`,
  `list_files`, `run_command`, project-scoped, ≤15 rounds) so they edit
  the composition like a CLI agent — not reply-only. Tool calls stream
  as `› tool_name path` lines.
- `POST /agent/chat {message, annotation?}` → `{jobId, name, cmd, edits}` —
  runs the resolved agent in the project dir, broadcasts output to SSE
  listeners. Preset headless cmds: `claude -p --dangerously-skip-permissions`,
  `codex exec --dangerously-bypass-approvals-and-sandbox "{prompt}"`,
  `gemini --yolo -p "{prompt}"`, `opencode run "{prompt}"`,
  `aider --yes-always --message "{prompt}"`.
- `GET /agent/jobs/:id/stream` → SSE replay + live chunks + `done` event.
- `GET /file?p=annotations/x.png` → thumbnail service for chat cards.
- Chat panel (`donova-rebrand-chat-v1` inject): collapsible agent window
  with an agent-picker dropdown; picking an unconfigured API provider opens
  an inline setup form (key/model/url fields as needed → save & use), and
  picking an uninstalled CLI prints its install command. The annotate
  overlay's "Send to agent" routes through `window.__fcChat` — the
  annotation attaches as a card + the run streams live in-thread.
- Same contract will be implemented by `apps/api` for hosted mode
  (plan/12) — UI is backend-agnostic.
