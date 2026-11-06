# 09 — AI Agent (`@framecraft/agent`) and Skills (`skills/`)

Two ways AI authors videos:
1. **External coding agents** (Claude Code, Cursor, Codex, Gemini CLI) use the CLI +
   installed **skills** (Markdown knowledge packs).
2. **Built-in agent** inside Studio/desktop/CLI (`framecraft agent`) — our own loop with
   typed tools, using the same skills as its knowledge.

Quality of output is dominated by the skills content and by the feedback loop
(write → check → snapshot → look → fix). Invest here.

## 1. Skills format

```
skills/<skill-name>/
├── SKILL.md               # YAML frontmatter + body
└── references/*.md        # loaded on demand
```
Frontmatter:
```yaml
---
name: framecraft
description: "<one paragraph: exactly when to use this skill; agents route on this text>"
version: 0.1.0            # matches CLI minor version
---
```
Body rules: imperative, concrete, short sections, real code examples that pass `check`,
explicit "never do X" lists, and a routing table to references.

## 2. Skill catalog to write

### Core set (installed by default)
1. **`framecraft`** (entry/router) — what Framecraft is; the contract in 30 lines; the work loop
   (plan → scaffold → author → `check` → `snapshot` → fix → `render`); routing table to the
   workflows and the other skills; the non-negotiable rules (01 §3–4, 02 determinism, lint top-10).
   References: `contract.md`, `work-loop.md`, `layout-and-safe-zones.md`, `troubleshooting.md`
   (map every lint/check code → fix).
2. **`framecraft-cli`** — every command by job, JSON output shapes, reading `check` output,
   recovering from render failures (per error code).
3. **`framecraft-animation`** — GSAP for seekable video: timeline structure (one paused root
   per composition, nested non-paused children, labels per scene), position parameter,
   eases vocabulary and when to use each, stagger, text splitting, SVG draw, masks,
   camera moves (scale/translate on a stage wrapper), transitions between scenes
   (crossfade, push, zoom-through, whip, wipe, mask reveal), motion principles
   (anticipation, overshoot, hold before climax, consistent direction across cuts,
   no idle wobble), timing tables (title in 0.5–0.8 s, hold ≥ 1.5 s per line read, etc.),
   other adapters (Lottie, three, anime, WAAPI) with registration snippets.
4. **`framecraft-media`** — getting/making media: transcription, captions, TTS voiceover, music
   & SFX sourcing, stock b-roll (Pexels/Pixabay API), image generation, background removal,
   color grading attrs, audio mixing attrs (volume, fades, ducking groups, fx).
5. **`framecraft-registry`** — search before building any named visual; `catalog`/`add`; wiring
   blocks (host element attrs) and components; authoring new blocks.

### Workflows (on demand; each a skill with a step-by-step procedure + acceptance checklist)
6. `talking-head-captions` — MP4 in → transcribe → caption style → embed → check → render.
7. `talking-head-recut` — footage + transcript → cut list (silence/filler removal) → overlays (titles, lower thirds, b-roll, callouts) synced to words.
8. `product-promo` — URL or brief → capture site screenshots (Playwright) → script → storyboard (scenes with durations) → build scenes as sub-comps → VO + music → render.
9. `faceless-explainer` — topic/text → script (hook, 3–5 beats, CTA) → TTS → visuals per beat → captions.
10. `motion-graphic` — < 10 s kinetic type / stat count-up / logo sting / lower third / transparent overlay.
11. `music-video` — audio → `beats` → beat grid → cut images/videos on beats.
12. `slideshow` — deck with discrete slides, fragments, presenter notes (output = interactive HTML, and optional MP4).
13. `style-from-references` — run Style Bible analyzer, confirm tokens with user, apply.

Each workflow skill ends with a **definition of done**: `check` passes with 0 errors, user-
visible snapshot contact sheet reviewed, render succeeded, durations match script.

## 3. Skill installation
`framecraft skills update` copies `skills/` (bundled in the CLI package at its version) into
every detected agent directory:
- project: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/` (if `.cursor/` exists), `.codex/skills/`
- user (with `--global`): `~/.claude/skills/`, `~/.agents/skills/`
Write a `.framecraft-skills.json` manifest (name → version, sha256) to detect local edits;
never overwrite a locally modified skill without `--force`.
Also publish a Claude Code plugin manifest (`.claude-plugin/plugin.json`) and a
`gemini-extension.json` in the repo for marketplace installs.

## 4. Built-in agent

### 4.1 Provider interface
```ts
interface LlmProvider {
  id: "anthropic" | "openai" | "local";
  chat(req: { system: string; messages: Msg[]; tools: ToolDef[]; maxTokens: number; signal }):
    AsyncIterable<StreamEvent>; // text deltas, tool_use, stop
}
```
Default: Anthropic Claude (latest Sonnet-class model id configurable). Images (snapshots)
sent as image content blocks. Keys: env `ANTHROPIC_API_KEY`, desktop settings (OS keychain
via `keytar`), or hosted proxy (cloud plan; server holds key and meters tokens).

### 4.2 Tools (JSON-schema typed; all scoped to project root)
| Tool | Input | Output |
|---|---|---|
| `list_files` | `{glob?}` | paths + sizes |
| `read_file` | `{path, startLine?, endLine?}` | text |
| `write_file` | `{path, content}` | ok + lint summary |
| `edit_file` | `{path, oldString, newString}` | ok + lint summary (exact-match replace, error if not unique) |
| `patch_element` | patch-element body (08 §11) | ok |
| `get_timeline` | `{composition?}` | compiled clips JSON |
| `probe_media` | `{path}` | probe |
| `run_check` | `{}` | findings (top 30) + contact sheet image |
| `snapshot` | `{times: number[]}` (≤ 8) | images |
| `render` | `{quality, format, range?}` | result (async job; agent waits) |
| `transcribe` | `{path, model?}` | transcript summary + file path |
| `tts` | `{text, voice?, out}` | audio path + duration + word timings path |
| `search_blocks` | `{query}` | items |
| `add_block` | `{name, into?, at?}` | wired element id |
| `search_stock` | `{query, kind: video|image, orientation}` | candidates (url, preview, license) |
| `download_asset` | `{url, name}` | local path |
| `generate_image` | `{prompt, size}` | path (if provider configured) |
| `analyze_style` | `{paths}` | style.json |
| `ask_user` | `{question, options?}` | answer (Studio UI renders choices) |

### 4.3 Loop
```
system = skills/framecraft/SKILL.md + selected workflow skill + project context
         (framecraft.json, composition list, style.json summary, selection, playhead)
loop (max 40 tool calls per turn, max 3 consecutive failing checks):
  model → tool calls → execute → results
  after any write: auto-run lint; include findings in tool result
  before declaring done: model must call run_check; if errors → continue fixing
  for visual changes: model should call snapshot and inspect
history group = the turn (undo reverts the whole turn)
```
Guardrails: tool calls outside project root rejected; `render` / downloads / paid generation
require user confirmation in Studio unless "auto-approve" setting on; token and cost
budget per turn shown in UI.

### 4.4 Context management
Summarize long tool outputs (> 8 KB) to file references; keep last 6 snapshots as images,
older ones as text descriptions; compact conversation when > 70% of context window.

### 4.5 Evaluation harness (`agent/evals/`)
20 briefs (promo, captions, explainer, motion graphic, edit requests on existing projects).
Run headless with a real model nightly: score = check passes (40%), render succeeds (20%),
duration within ±10% of brief (10%), rubric-scored by an LLM judge from contact sheet (30%).
Track scores over time; skills changes must not regress the mean.

## 5. Acceptance criteria
- Skills install into a temp project for all supported agent dirs; modified skill not overwritten without `--force`.
- Agent with a scripted fake provider completes a fixed tool sequence; undo reverts turn.
- With real model (manual/nightly): ≥ 70% eval score before v1 launch.
