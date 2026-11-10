---
name: framecraft-cli
description: Framecraft CLI reference — every command, flag, --json envelope shape, error codes, exit codes, and recovery recipes. Use when running framecraft/fc commands, parsing their output, debugging render/check/scaffold/transcribe/cuts failures, or wiring Framecraft into scripts and agents.
---

# Framecraft CLI

Binary: `framecraft` (alias `fc`). Node ≥22 required.

Every command accepts `--json` — output is `{ok: true, data: {...}}` on stdout
or `{ok: false, error: {code, message, hint}}` with exit 1. Human output goes
to stderr in `--json` mode. Error codes: `E_INTERNAL`, `E_INVALID_PROJECT`,
`E_CHECK_FAILED`, `E_FILE_NOT_FOUND`, `E_BINARY_MISSING`, `E_MODEL_ERROR`,
`E_PROVIDER_ERROR`, `E_RENDER_FAILED`, `E_BLOCK_NOT_FOUND`,
`E_NEEDS_CONFIRMATION`.

## Project & media

- `init [dir] [--footage media.mp4] [--width --height]` — new project; with
  footage it copies media to `assets/` and scaffolds a cover-crop comp.
- `probe <media> --json` → `{duration,width,height,fps,hasAudio,codec,pixFmt}`.
- `timeline [dir] [--json]` → resolved clip list: id/tag/kind/start/duration/
  src/mediaIndex/hasAudio per clip.
- `check [dir] [--no-browser] [--json]` — lint + headless gate. Exit 1 on any
  error. `--no-browser` for static lint only (CI-safe).

## Footage pipeline

- `transcribe <media> [--engine auto|parakeet|whisper] [--model large-v3-turbo]
  [--language en] [--prompt "names, jargon"] [--out transcript.json] --json`
  → word-level transcript. Engine `auto` (default) prefers NVIDIA
  **parakeet-tdt-0.6b-v3** via sherpa-onnx — better WER than whisper-large-v3
  and ~5-10x faster, covering English + 25 European languages, model
  auto-downloads (~670MB, sha256-verified). `whisper` uses local whisper.cpp
  (default `large-v3-turbo`; `small.en` for speed) and is the fallback when
  Parakeet is unsupported or the language is outside its set. `--prompt`
  biases recognition AND stitches fragment-spelled terms ("F iver r"→"Fiverr")
  — pass names/jargon whenever known.
- `models [install parakeet|<whisper model>] [--json]` — list model status or
  prefetch a model without a media file.
- `cuts <transcript.json> [--threshold 0.35] [--pad 0.06] [--out cuts.json]`
  → dead-air cut plan. Accepts framecraft or raw whisper-cli JSON.
- `scaffold <media> [--cuts cuts.json|--transcript t.json] [--width --height]
  [--dir .] [--out index.html]` → neutral segmented index.html.
- `captions --transcript t.json --cuts cuts.json [--mode word|phrase]
  [--emphasis "w1,w2"]` → generate caption track into index.html
  (install the `word-captions` block first for styles).

## Look / verify

- `snapshot <dir> --times 0.5,2,8 [--out snaps] [--contact-sheet sheet.png]
  [--cols 3]` — PNGs at exact times; the sheet tiles them with timecode labels.
- `compare <a.mp4> <b.mp4>` — PSNR; `∞` = identical.
- `catalog [--type block|sfx] [--query x]` — search installed registry items.

## Render

- `render [dir] [-o|--out out.mp4] [--fps N] [--quality draft|standard|high]
  [--format mp4|webm|mov|gif|png-seq|hls] [--alpha] [--workers N|auto]
  [--range START-END] [--draft] [--scale 0.5] [--profile]
  [--engine auto|framecraft|hyperframes] [--json]`
  - `--range 1.5-4` renders only that window (audio trimmed to match).
  - `--draft` = half-res (scale 0.5) fast pass; `--scale` arbitrary.
  - `--profile` prints stage timings: extract-frames, capture+encode,
    audio-mix, mux.
  - `--workers auto` ≈ cores/3 capped at 8.
  - **Engine routing** (`--engine auto`, default): the comp tree is scanned
    for Studio-only features the framecraft engine doesn't implement yet —
    `data-motion-blur`, `data-color-grading`, `data-audio-group` /
    `<hf-audio-group>`, `data-automation`, `data-fx-chain`, `data-vfx-chain`,
    `data-playback-start`, `data-lottie-src`, shaders. If any are present the
    render runs through the hyperframes engine (identical to Studio Export),
    so preview and render never diverge. Otherwise the framecraft engine
    renders (byte-deterministic, golden-tested). `fc check` prints the
    decision + the triggering features as info rows; `--json` includes
    `engine` and `reasons`. Force with `--engine framecraft|hyperframes`.
  - Output audio is always 48 kHz stereo (mono sources upmixed), matching
    hyperframes.
- `add <block> [--dir .]` — install a registry block into `compositions/`;
  `add sfx/<name>` drops an SFX into `assets/sfx/`.

## Style & skills

- `style init [--global]` / `style show` / `style path` — the user-owned
  style.md (project-local beats `~/.config/framecraft/style.md`).
- `skills update [dir]` — install the Framecraft skill set into an agent's
  skill directory (`.claude/skills`, `.agents/skills`).
- `mcp` — run the MCP server (stdio) exposing Framecraft tools.

## Interactive

- `preview [dir]` — serve the composition at a local URL for scrubbing.
- `studio [dir] [--port N]` — the Studio editor (canvas, timeline, inspector,
  agent chat). Binds 127.0.0.1.

## doctor

- `doctor [--json] [dir]` — node/ffmpeg/ffprobe/chrome/whisper/disk/RAM/cache
  checks with fix hints. Optional project-validity check when given a dir.

## Exit codes

0 success; 1 failure (check errors, render failures); 2 usage errors.
