# 06 — CLI (`@donova/cli`, binary `donova`, alias `do`)

Built with `citty`; each command is a lazily imported module (`src/commands/<name>.ts`) so
`donova --version` starts in < 100 ms. Every command supports `--json` (machine
output: a single JSON object on stdout; logs go to stderr) and `--help` with examples.
Exit codes: 0 success, 1 runtime error, 2 usage error, 3 lint/check failure.

Global flags: `--cwd <dir>`, `--json`, `--verbose`, `--quiet`, `--no-color`.
Env: `DONOVA_NO_TELEMETRY=1`, `DO_NOT_TRACK=1` (both disable telemetry),
`DONOVA_FFMPEG_PATH`, `DONOVA_CHROME_PATH`, `DONOVA_API_URL`, `DONOVA_CACHE_DIR`.
Load `.env` from cwd (never overriding existing env).

## 1. Command reference

### Project
| Command | Flags | Behaviour |
|---|---|---|
| `init [name]` | `--template <id>` (default `blank`), `--aspect 16:9|9:16|1:1|4:5`, `--width --height --fps --duration`, `--tailwind`, `--no-install`, `--no-skills`, `--git` | Create project from `registry/examples/<template>`; write `donova.json`, `meta.json` (uuid), `AGENTS.md` + `CLAUDE.md` (identical, from `cli/templates/_shared/`), `package.json` with scripts (`dev`, `check`, `render`) pinning exact CLI version; vendor gsap; install core skills unless `--no-skills`. Interactive prompts (`@clack/prompts`) when TTY and flags missing |
| `info` | | Print project summary: entry, dimensions, fps, duration (+source), clip count, media list with probe info, compositions tree |
| `compositions` | | List compositions (id, file, size, duration, variables) |
| `timeline` | `--composition`, `--format table|json` | Print compiled timeline (clips with abs start/end, tracks) |
| `doctor` | | Check Node, ffmpeg/ffprobe versions + codecs (libx264, libvpx-vp9, prores_ks, aac), chrome-headless-shell, disk, RAM, GPU encoders, write permission, project validity. Each check ✓/⚠/✗ with fix hint |
| `browser ensure|path|clear` | | Manage chrome-headless-shell |
| `clean` | `--frames --remote --all` | Clear caches |
| `upgrade` | `--check`, `--project` | Update CLI (npm) and rewrite pinned versions in project `package.json` |

### Author loop
| Command | Flags | Behaviour |
|---|---|---|
| `preview` | `--port` (default 3017), `--open/--no-open`, `--background`, `--status`, `--stop`, `--host 127.0.0.1` | Start studio-server serving Studio UI + project; live reload. `--background` daemonizes (pidfile `~/.cache/donova/preview/<hash>.json`), returns URL; `--status` / `--stop` manage it (agent-safe) |
| `lint` | `--json`, `--fix`, `--rule <id>`, `--verbose` (include info) | Static rules (07-LINT) |
| `check` | `--json`, `--samples N`, `--strict` | lint + browser gate (runtime errors, layout overflow, contrast, motion sanity, media load). Exit 3 on errors |
| `snapshot` | `--at 0,1.5,3` or `--every 1`, `--frames 0,45`, `--out dir`, `--grid` (contact sheet), `--scale 0.5`, `--composition` | Render PNG stills at times via the same capture path as render. Prints file paths (agent uses them to "look") |
| `compare` | `<a.png|mp4> <b.png|mp4>` `--threshold-psnr 40` | PSNR/SSIM report; diff image |
| `render` | see 04-PRODUCER RenderOptions: `-o/--output`, `--fps`, `--quality`, `--format`, `--codec`, `--crf`, `--resolution`, `--from --to`, `--workers`, `--capture-mode`, `--gpu`, `--browser-gpu`, `--composition/-c`, `--var k=v`, `--vars file`, `--normalize-audio`, `--low-memory`, `--docker`, `--keep-temp`, `--no-lint` | Render with progress bar (TTY) or NDJSON progress (`--json`). `--docker` runs inside the published render image for reproducibility |
| `batch` | `<config.json|csv>` | Render many variants: each row = variables + output name; parallel jobs limit |
| `keyframes` | `<file> --element <id>` | Print GSAP tweens affecting an element (from runtime introspection) — helps agents debug motion |
| `history` | `--limit` | Render history (04 §8) |

### Media & AI (10-MEDIA-AI)
| Command | Behaviour |
|---|---|
| `transcribe <media>` `--model tiny|base|small|medium|large-v3` `--language` `--out transcript.json` | whisper.cpp local, word timestamps |
| `captions <transcript.json>` `--style <block>` `--max-chars 32` `--out compositions/captions.html` | Generate caption sub-composition |
| `tts "<text>"|--file script.txt` `--voice` `--provider local|elevenlabs|openai` `-o` | Speech + word timings JSON |
| `remove-background <image|video>` `-o` | ONNX matting; image → PNG, video → WebM alpha |
| `beats <audio>` `--out beats.json` | Tempo + beat + downbeat times |
| `silence <media>` `--threshold -35dB --min 0.4` | Silence ranges JSON |
| `normalize-audio <in>` `-o --lufs -14` | Loudness normalize file |
| `analyze-style <videos...>` `--out style.json` | Style Bible analyzer (14 §3) |

### Registry (11-REGISTRY)
| Command | Behaviour |
|---|---|
| `catalog [query]` `--type block|component` `--tag` `--json` | Search registry (local fuzzy over cached index; refresh daily) |
| `add <name...>` `--tag <t>` `--into <composition>` `--at <seconds>` `--force` | Install item files, scope CSS, localize fonts, optionally wire host element into `index.html` |
| `remove <name>` | Remove installed item and its host element |

### Agent skills
| Command | Behaviour |
|---|---|
| `skills list` | Installed + available |
| `skills update [name...]` | Install/refresh skills matching CLI version into detected agent dirs (`.claude/skills`, `.agents/skills`, `.cursor/skills`, `~/.claude/skills` …) |
| `agent "<prompt>"` | Run the built-in agent (09) headless in the terminal on this project |

### Cloud (12-CLOUD)
| Command | Behaviour |
|---|---|
| `auth login|logout|status` | Device flow (RFC 8628) |
| `cloud render` `[render flags]` `--wait` | Upload bundle, queue render, stream progress, download |
| `cloud list|status <id>|download <id>|cancel <id>` | |
| `publish` `--private|--unlisted|--public` | Upload render + project; print share URL |
| `usage` | Credits and quotas |

### Telemetry
`telemetry status|enable|disable`. Opt-in prompt on first interactive run; default **off**
in CI and non-TTY. Events: command name, duration, success, error code, versions, OS. Never file paths or content.

## 2. Output conventions
- Human mode: `◆` headings, ✓/⚠/✗, colors via `picocolors`, progress bar with stage + ETA.
- JSON mode, short commands: exactly one JSON document on stdout.
- JSON mode, long commands (`render`, `cloud render`, `transcribe`, `batch`): NDJSON on
  stdout — zero or more `{"type":"progress",...}` lines then exactly one
  `{"type":"result",...}` (or `{"type":"error",...}`) line. Document this in `--help`.
- Errors: `✗ <message>\n  hint: <hint>\n  code: <E_CODE>`.

## 3. Templates shipped (`registry/examples`)
`blank` (16:9), `blank-vertical` (9:16), `talking-head-captions`, `product-promo`,
`explainer`, `slideshow`, `music-visualizer`, `lower-thirds-pack`, `podcast-clip`.
Each: renders and passes `check` in CI.

## 4. Scaffolded AGENTS.md / CLAUDE.md content (in every project)
Short: what the project is, "use skills first" (list core skills), commands
(`npm run dev`, `npx donova preview --background`, `check`, `render`), key contract
rules (6 bullets mirroring 01 §3–4 + determinism), "always run check after editing".

## 5. Acceptance criteria
- Command matrix test: each command `--help` exits 0; each runs against fixtures with `--json` and output validates against a JSON schema per command (`cli/schemas/<cmd>.json`).
- `init` → `check` → `render` succeeds for every template.
- `preview --background` → `--status` reports running → `--stop` kills; no orphan processes.
- Cold start `donova --version` < 150 ms.
