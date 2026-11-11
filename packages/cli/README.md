# Donova

Describe your edit, ship your video. Donova is an AI-assisted video editor:
import raw footage, direct the edit in natural language (or by drawing on
the frame), preview in Studio, render to MP4.

## Install

```bash
npm i -g donova
```

Requires Node 20+. FFmpeg and a headless browser are bundled/managed —
no separate installs.

## Quickstart

```bash
donova init my-edit     # scaffold a project
cd my-edit
donova studio           # open Donova Studio (preview + timeline + agent chat)
donova check            # lint + runtime gate
donova render -o out.mp4
```

## The vibe-edit loop

1. `donova init` (or `donova scaffold ./footage.mov` to start from footage)
2. `donova studio` — watch the preview; every file edit hot-reloads
3. Describe changes in the **agent chat** (bottom-right pill), or switch to
   the **Annotate** tab to draw on the frame — circle a subject, arrow a
   motion direction — attach a note, send to the agent
4. `donova check` before every render, `donova render` to ship

## Agents — bring your own model

The chat panel dropdown lists every detected agent:

- **CLI presets** — Claude Code, Codex, Gemini CLI, OpenCode, Aider
  (auto-detected on PATH; full file-edit power)
- **API providers** — OpenAI, Gemini, OpenRouter, Ollama, LM Studio, or any
  OpenAI-compatible endpoint. Pick one, paste the key in the panel —
  stored in `~/.donova/agents.json` (never in the project)

API agents edit through a sandboxed tool loop (`read_file`, `write_file`,
`list_files`, `run_command`) scoped to the project directory.

Custom agent:

```json
// donova.json
{ "agent": { "cmd": "my-agent run {prompt}" } }
// or an OpenAI-compatible endpoint:
{ "agent": { "url": "http://localhost:11434/v1/chat/completions", "model": "llama3.2" } }
```

## Composition format

Projects are plain HTML compositions — `class="clip"`, `data-start`,
`data-duration`, GSAP timelines on `window.__timelines`. Deterministic:
no `Date.now()`, no unseeded randomness. Studio-only features (motion
blur, grading, audio groups, automation, FX/VFX, Lottie, shaders) render
through the bundled HyperFrames engine automatically — `donova check`
reports which engine will render.

## Commands

`init · studio · preview · check · render · add · catalog · skills ·
cuts · captions · transcribe · inspect · timeline · snapshot · compare ·
style · scaffold · doctor · mcp` — `donova --help` for the full list.

## License

Commercial software — © Dyligent. See LICENSE and NOTICE.md.
