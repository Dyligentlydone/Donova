# 17 — Vibe Editing (PRIORITY TRACK)

> This file defines the product's north star and the **priority track (MV)** in
> `16-BUILD-ORDER.md`. Where it conflicts with older plan files, **this file wins**.
> Read `plan/STATUS.md` first so you know what already exists.

## 0. North star

Editnce is a video editor **for other people**. The core experience is
**vibe editing**: a user drops in raw footage, describes the edit they want in plain
language, and an AI agent produces it. The user then gives feedback ("cut the pauses",
"captions bigger", "no black bars"), the agent revises, and it **remembers** those
preferences for next time.

This is how the owner used HyperFrames with an external coding agent to produce
Instagram Reels from talking-head footage. We are making that loop:

1. work with any agent (Claude Code, Cursor, Codex, Devin…) via CLI + skills + MCP, and
2. work for non-developers via a **chat panel inside Studio** (the web app),

with the same tools, the same skills, and the same project files behind both.

### Hard product rules

1. **No creator's style is built into the app.** The app ships *neutral* tools,
   *neutral-default* blocks, and *general* editing knowledge. A user's taste lives in
   **their** `style.md` (§5). Never hard-code a palette, font, zoom amount, caption
   look, or sound choice into a tool or skill as "the" way. Defaults must look clean
   and plain; everything is overridable through block variables.
2. **The composition HTML is the source of truth.** The agent edits files; Studio
   edits files; renders read files. No hidden edit database. Helper JSON files
   (`transcript.json`, `cuts.json`) are inputs the agent uses to *write* HTML.
3. **Every tool is agent-first.** Stdout = data (JSON with `--json`), stderr =
   messages, never prompts when unattended, stable error codes (§4.1).
4. **The agent must look at its work.** Skills and the built-in loop require
   `check` + `snapshot` before declaring done.
5. **User footage stays local** unless the user explicitly uses a cloud feature.
6. Avatars remain out of scope. GSAP rule from `AGENTS.md` still applies (Studio UI
   never writes GSAP; the *agent* may write GSAP code because that is code authoring).

### What "done" looks like for this track

A new user with a talking-head MP4 and no style file can, in Studio's chat, type
"make this a 9:16 reel: cut the dead air, add bold one-word captions, a title card,
and subtle sound effects", and within one agent turn get a composition that passes
`check`, shows a correct preview, and renders. Their follow-up feedback ("make the
captions yellow and always do that") is applied **and** written to `style.md`, and a
second project picks it up automatically.

---

## 1. The vibe-edit loop

```
 user brief / feedback
        │
        ▼
 ┌──────────────┐  reads   ┌──────────────────────────────────────────────┐
 │  agent       │────────▶ │ skills (general craft)  +  style.md (taste)  │
 │ (external or │          └──────────────────────────────────────────────┘
 │  Studio chat)│  calls tools (CLI / SDK / MCP — identical semantics)
 └──────┬───────┘
        │ 1. probe + transcribe footage        → transcript.json
        │ 2. compute cuts (dead air, fillers)  → cuts.json (word times remapped)
        │ 3. scaffold or edit composition      → index.html (+ compositions/*)
        │ 4. add blocks / sfx from registry    → assets/, blocks wired
        │ 5. check  (lint + browser gate)      → fix until 0 errors
        │ 6. snapshot key moments / contact sheet → LOOK at frames, fix
        │ 7. render (draft first, then final)
        │ 8. user feedback → revise → persist durable preferences to style.md
        └───────────────────────────────────────────────────────────────▶
```

Project layout for a footage project (created by `editnce init --footage` or by
the agent):

```
my-reel/
├── editnce.json          # { "name", "style": "./style.md" | "~/.config/editnce/styles/<n>.md" }
├── style.md                 # user's taste (optional; §5)
├── index.html               # the edit (source of truth)
├── compositions/            # optional sub-comps (captions.html, cards…)
├── assets/
│   ├── raw/                 # original footage, never modified
│   ├── sfx/                 # installed sound effects (from registry)
│   └── blocks/…             # installed blocks
├── transcript.json          # from `editnce transcribe`
├── cuts.json                # from `editnce cuts`
└── .editnce/             # cache (frames, history, renders) — gitignored
```

---

## 2. Reference: how the owner's manual edit was built

`plan/STATUS.md §4` documents a real edit made with this codebase (talking head →
9:16 reel with dead-air cuts, one-word captions, glass cards, punch-in zooms, SFX,
grade). Its generator script (`build.py`, outside the repo) proved the pipeline. Your
job is to turn the *mechanisms* it used into general tools/blocks/skills — **not** to
reproduce its look. Mechanism → product mapping:

| What build.py did by hand | Becomes (general, style-free) |
|---|---|
| Parse whisper JSON → word list | `editnce transcribe` → `transcript.json` (§4.3) |
| Collapse gaps > 0.35 s into segments, remap word times | `editnce cuts` → `cuts.json` (§4.4) |
| Emit N `<video>` segments with `data-media-start` | `editnce scaffold footage` (§4.5) |
| One `<span>` per word with pop motion | `word-captions` block (§7) |
| Glass card / pill / alert / stat card | `card`, `pill`, `alert-card`, `stat-card` blocks (§7) |
| Alternate zoom 1.0/1.12 per segment | skill guidance + `punch-zoom` motion preset (§6, §7) |
| White flash at hook | `flash` transition block (§7) |
| CSS grade + vignette | `grade` component (§7), values from style.md |
| SFX at beats via `<audio data-audio-offset>` | registry `sfx` items + skill guidance (§7.3) |
| Accent/danger word lists, 1.18 zoom, green #1dbf73 | **user's style.md only** — never in the app |

---

## 3. Track overview (task IDs match `16-BUILD-ORDER.md` MV section)

| ID | Deliverable | Section |
|---|---|---|
| MV0 | Stabilize what exists (attribute names, alpha frames, tests, JSON contract) | §3.1 |
| MV1 | Agent tool layer: `doctor`, `transcribe`, `cuts`, `scaffold footage`, `probe`, `timeline`, `snapshot --contact-sheet`, `render --draft`, `catalog` | §4 |
| MV2 | Style file support (`style.md`) | §5 |
| MV3 | Skills for footage editing | §6 |
| MV4 | Neutral blocks + SFX library | §7 |
| MV5 | `@editnce/sdk` + MCP server | §8 |
| MV6 | Studio vibe-edit chat (built-in agent) | §9 |
| MV7 | Render speed for the feedback loop | §10 |
| MV8 | Background removal (with model bake-off) | §11 |
| MV9 | TTS | §12 |
| MV10 | Vibe-edit eval suite + end-to-end acceptance | §13 |

### 3.1 MV0 — Stabilize

1. **Canonical media trim attribute.** Spec `01 §` says `data-media-start` is canonical.
   Code currently reads `data-trim-start` (video frames, `engine/src/videoFrames.ts`) and
   `data-audio-start` (audio, `producer/src/audio.ts`, `contract/src/parser.ts`). Make
   `data-media-start` canonical in `names.ts`, accept the other two as deprecated
   aliases (lint rule `media-start-alias`, severity info, autofix). One value must
   drive both video frames and audio so they can never drift.
2. **Alpha media frames.** `videoFrames.ts` extracts JPG (`FRAME_EXT = "jpg"`), which
   drops transparency. Probe each video (`ffprobe` `pix_fmt`; alpha if it contains
   `a` e.g. `yuva420p`, `argb`, `rgba`, or codec is `prores` 4444 / `vp9` with
   `alpha_mode=1` tag). Alpha → extract PNG (`-compression_level 1`), else JPG `-q:v 2`.
   For VP9 alpha WebM you must decode with `-c:v libvpx-vp9` *before* `-i` or alpha is
   lost. Reference: HyperFrames `packages/engine/src/services/videoFrameExtractor.ts`
   (`resolveFrameFormat`). Acceptance: a WebM-alpha fixture over a colored background
   renders with the background visible through the transparent region.
3. **Tests that actually run.** Root `pnpm test` runs turbo, but packages have no `test`
   scripts; only `pnpm vitest run` runs `tests/`. Add per-package `test` scripts or make
   root `test` = `vitest run`. Create `vitest.golden.config.ts` (referenced by
   `test:golden`, currently missing) with at least: basic fixture determinism (two
   renders byte-identical), media fixture frame-accuracy (barcode/timecode), parallel
   vs serial PSNR ≥ 45 dB.
4. **JSON output contract** for every existing command (§4.1). Today only `check`
   supports `--json`.
5. **`check` noise.** `no-animations` info fires on every non-GSAP project even when
   `data-fc-motion` is used; suppress when any `data-fc-motion` exists.
   `clip-missing-class` should not fire for timed containers that are clearly overlay
   wrappers holding only `<audio>` (an SFX holder) — accept an explicit
   `data-role="audio"` or skip elements whose only children are audio.

---

## 4. MV1 — Agent tool layer (CLI)

### 4.1 Output contract (all commands)

Mirror HyperFrames `packages/cli/AGENTS.md` (read it):

- Results → **stdout**. Progress, warnings, notices → **stderr**.
- `--json`: stdout is exactly one JSON document. Success:
  `{"ok": true, "data": {...}}`. Failure: `{"ok": false, "error": {"code", "message", "hint"?}}`.
- Exit codes: `0` success, `1` ran and failed, `2` bad usage.
- Unattended detection (`!process.stdout.isTTY || CI || EDITNCE_AGENT=1` or known
  agent env vars): never prompt; a command needing confirmation requires `--yes`.
- Progress lines on stderr are newline-terminated (not `\r`) when unattended, so
  agents' log capture stays readable. Current `render` writes `\r` — fix.
- Error codes are stable strings defined in one module (`packages/cli/src/errors.ts`):
  `E_FFMPEG_MISSING`, `E_CHROME_MISSING`, `E_MODEL_DOWNLOAD`, `E_TRANSCRIBE_FAILED`,
  `E_MEDIA_UNREADABLE`, `E_COMPOSITION_INVALID`, `E_RENDER_WORKER_FAILED`, `E_USAGE`, …
- A contract test runs every registered command with `--json` and bad args and
  asserts the envelope + exit code (like HF `src/cli.agentMode.test.ts`).

### 4.2 `editnce doctor [--json]`

Checks, each `{id, status: "ok"|"warn"|"fail", detail, fix?}`:

| id | How | Fail/warn condition | Fix hint |
|---|---|---|---|
| `node` | `process.versions.node` | < 22 fail | install Node 22+ |
| `ffmpeg` | `ffmpeg -version` | missing fail; < 6 warn | `brew install ffmpeg` / apt / winget per OS |
| `ffmpeg-codecs` | `ffmpeg -encoders` | missing libx264/aac fail; libvpx-vp9/prores_ks/libopus warn | build with those encoders |
| `ffprobe` | `ffprobe -version` | missing fail | same as ffmpeg |
| `chrome` | `ensureChrome({install:false})` | missing warn (auto-installs on first render) | `editnce browser ensure` |
| `beginframe` | cached probe verdict | false → warn "screenshot capture (slower)" | informational |
| `whisper` | binary + default model present | missing warn | `editnce transcribe --install` |
| `disk` | free space on cache + project volume | < 5 GB warn, < 1 GB fail | free space |
| `memory` | `os.totalmem()` | < 8 GB warn | fewer workers |
| `cache-writable` | write/delete temp file in `~/.cache/editnce` | not writable fail | fix permissions |
| `project` | if cwd has `index.html`: run lint only | errors → warn | `editnce check` |

Exit 1 if any `fail`. Human output: one line per check with ✓/⚠/✗ and the fix.
Reference: HF `packages/cli/src/commands/doctor.ts`.

### 4.3 `editnce transcribe <media> [--model small.en] [--language auto] [--out transcript.json] [--install] [--json]`

- **Own install, no borrowing.** Models download to `~/.cache/editnce/whisper/models/`
  from `https://huggingface.co/ggerganov/whisper.cpp/resolve/<PINNED_REVISION>/ggml-<model>.bin`.
  Pin a revision and sha256 per model in code (HF pins
  `5359861c739e955e79d9a303bcbc70fb988958b1` in `packages/cli/src/whisper/manager.ts` —
  verify hashes yourself; do not trust this file for hashes). Verify sha256 after
  download; download to `*.partial` then rename; resumable via HTTP Range.
- **Binary.** Prefer `whisper-cli` on PATH (Homebrew `whisper-cpp` installs it). If
  absent: macOS → hint `brew install whisper-cpp`; Linux → build from a pinned
  whisper.cpp release tag with cmake into the cache dir (document the exact commands);
  Windows → download the official release zip. Record the version (`whisper-cli
  --version` or `--help` header) in transcript metadata.
- **Pipeline (verified working on this machine):**
  1. `ffmpeg -i <media> -ar 16000 -ac 1 -c:a pcm_s16le <tmp>.wav`
  2. `whisper-cli -m <model> -f <tmp>.wav -oj -ml 1 -sow -of <tmp>` (add `-l <lang>`
     when not auto). Output `<tmp>.json` has `transcription[]` entries with
     `offsets.from/to` (ms) and `text`; with `-ml 1 -sow` each entry is ~one word.
     The first entry may be empty — skip entries whose trimmed text is empty.
     Punctuation is attached to words ("fishy,"); keep it in `text`, provide `norm`
     (lowercase, stripped punctuation) for matching.
  3. Write `transcript.json`:
     ```json
     {
       "version": 1,
       "source": "assets/raw/IMG_4063.MOV",
       "sourceSha1": "…",
       "model": "small.en",
       "language": "en",
       "duration": 47.80,
       "words": [ { "id": "w0", "text": "the", "norm": "the", "start": 0.00, "end": 0.55, "confidence": 0.91 } ],
       "segments": [ { "text": "…", "start": 0.0, "end": 4.1, "wordIds": ["w0","w1"] } ]
     }
     ```
     Segments: split at sentence punctuation (`.?!`) or gaps > 0.6 s.
  4. Filler tagging: `filler: true` on standalone `um, uh, er, ah, hmm, like, you know`
     (configurable list; "like"/"you know" only when surrounded by gaps > 0.15 s).
- Cache key: media sha1 + model + language → reuse existing transcript unless `--force`.
- Acceptance: 10 §9 WER/timing criteria on a fixture; re-running is instant (cache);
  missing binary gives `E_WHISPER_MISSING` with OS-specific hint.

### 4.4 `editnce cuts <transcript.json> [--max-gap 0.35] [--lead 0.08] [--tail 0.07] [--end-pad 0.25] [--fillers] [--keep a-b,…] [--drop a-b,…] [--out cuts.json] [--json]`

Pure function in `@editnce/media` (unit-testable, no I/O in the core). Algorithm
(this is exactly what produced the reference edit; keep defaults):

1. Start first segment at `max(0, words[0].start - lead)`.
2. Walk words; when `words[i].start - words[i-1].end > maxGap`, close the current
   segment at `prev.end + tail`, open a new one at `words[i].start - lead`.
3. With `--fillers`: treat filler words as gaps (remove them, then apply step 2).
4. Never cut inside a word: assert every word is either fully inside a kept segment
   or fully removed.
5. Close the final segment at `last.end + endPad`.
6. Apply manual `--keep`/`--drop` source ranges last (agent uses these for "cut the
   part where I say X").
7. Build the source→composition time map and remap every kept word.

Output `cuts.json`:
```json
{
  "version": 1,
  "source": "assets/raw/IMG_4063.MOV",
  "params": { "maxGap": 0.35, "lead": 0.08, "tail": 0.07, "endPad": 0.25, "fillers": false },
  "segments": [ { "id": "s0", "sourceStart": 0.0, "sourceEnd": 8.83, "compStart": 0.0, "compEnd": 8.83 } ],
  "duration": 42.18,
  "removed": 5.62,
  "words": [ { "id": "w0", "text": "the", "compStart": 0.0, "compEnd": 0.55, "segment": "s0" } ]
}
```
Words that were removed are omitted from `words` (keep them in `removedWords` for
"undo this cut" UIs). Also export `sourceToComp(t)` / `compToSource(t)` in the SDK.

Acceptance (unit): 60 s synthetic transcript with 8 s of gaps → duration within ±0.5 s
of expected; no word truncated; `compStart` monotonic; idempotent.

### 4.5 `editnce scaffold footage --media <path> [--transcript t.json] [--cuts c.json] [--size 1080x1920|1920x1080|1080x1080] [--fit cover|contain] [--captions none|words|phrases] [--out index.html] [--force]`

Writes a **neutral** starter composition the agent then customizes. Output must pass
`check` with 0 errors. Structure:

```html
<div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="42.180" data-fps="30">
  <!-- footage: one clip per cut segment, back to back -->
  <div class="clip fc-footage" id="s0" data-start="0.000" data-duration="8.830" data-track-index="0">
    <video src="assets/raw/IMG_4063.MOV" data-media-start="0.000" data-has-audio="true"></video>
  </div>
  …
  <!-- captions: installed `word-captions` block, generated from cuts.json words -->
  <div class="clip fc-captions" data-start="0" data-duration="42.180" data-track-index="2"> … </div>
</div>
```

Rules: the footage `<video>` uses `object-fit` from `--fit`; ids `s0…sN`; captions are a
separate track; **no grade, no zoom, no cards, no SFX** — those are the agent's job,
guided by style.md and skills. If `--cuts` is omitted, one segment covering the whole
media. Fps defaults to the source fps rounded to 24/25/30/60.

### 4.6 Other agent tools

| Command | Purpose | JSON `data` |
|---|---|---|
| `editnce probe <media>` | ffprobe normalized (10 §1) | `MediaProbe` |
| `editnce timeline [dir]` | compiled clip list | `{duration, fps, clips:[{id, start, end, track, kind, src?, text?}]}` |
| `editnce snapshot [dir] --times … [--contact-sheet] [--width 360]` | exists; add contact sheet (grid of N evenly spaced frames, labeled with timecode) and `--json` returning file paths | `{frames:[{t, path}], contactSheet?}` |
| `editnce render … --draft` | half resolution, JPEG q70, auto workers | `{out, frames, seconds, mode}` |
| `editnce render … --range 10-20` | render a time window (for previewing one beat) | same |
| `editnce catalog [query] [--type block|component|sfx] [--json]` | search registry | items with name, type, description, tags, vars |
| `editnce add <name> [dir]` | exists; also handles `sfx/*` (copy into `assets/sfx/`) and prints the wiring snippet | `{installed:[paths], snippet}` |
| `editnce style init|show|path` | §5 | style file path/content |

Worker auto-sizing for `render` (when `--workers` omitted): `min(cpus/2, floor(totalMemGB*0.5/1.0), 6, ceil(frames/120))`,
at least 1. Reference HF `packages/engine/src/services/parallelCoordinator.ts`
(`computeWorkerSizing`).

---

## 5. MV2 — The style file (`style.md`)

A plain Markdown file the **user owns**. The app provides a template, a place to keep
it, and the read/write protocol. The agent fills it from the user's words over time.

### 5.1 Location & linking
- Project-local `style.md`, or a reusable personal style at
  `~/.config/editnce/styles/<name>.md` referenced from `editnce.json`
  (`"style": "~/.config/editnce/styles/reels.md"`). Project-local wins if both exist.
- `editnce style init [--name reels] [--global]` writes the template;
  `editnce style show [--json]` prints resolved path + content.

### 5.2 Template (sections are fixed headings; content is free text)
```markdown
# Style
<!-- Owned by the user. The agent reads this before every edit and updates it when the
     user states a lasting preference. Keep entries short and concrete. -->

## Format
(aspect ratio, platform, typical length)

## Pacing & cuts
## Captions
## Graphics & overlays
## Color & look
## Audio & sound effects
## Transitions
## Do / Don't

## Decisions log
| Date | Decision | Source |
|---|---|---|
```
The owner's real style guide (outside the repo, see STATUS §4) is a good example of a
mature file. Do **not** ship its contents.

### 5.3 Agent protocol (put this in skills and in the built-in agent system prompt)
1. Before planning an edit: resolve and read the style file. If none exists, edit with
   neutral defaults and, at the end, offer to start one.
2. Treat style entries as defaults the brief can override for one video ("this one
   without music") — overrides for one video are **not** written back.
3. When the user expresses a lasting preference ("always", "never", "from now on",
   or the same correction twice), update the relevant section **and** append a
   Decisions-log row with date and `user`. Tell the user what was saved.
4. Never delete user-written lines; mark superseded ones `(superseded YYYY-MM-DD)`.
5. Keep it under ~400 lines; summarize the log when it grows.

### 5.4 Studio
"Style" panel: shows the resolved file in a Markdown editor (save = file write), a
"what the agent will apply" summary (the agent's last parse, cached), and a toggle
"apply my style to this project".

---

## 6. MV3 — Skills for footage editing

Format and install mechanics: `09 §1, §3`. Every HTML example in skills must pass
`check` (add the code-block extraction test from `T8.1`). Write **our own** text;
use HyperFrames' skills only as a checklist of topics.

### 6.1 Skill set
| Skill | Purpose |
|---|---|
| `editnce` (update existing `skills/editnce-core`) | Router: what Editnce is, contract summary, the vibe-edit loop (§1), hard rules, routing table |
| `editnce-footage` (**new, most important**) | Editing real footage end-to-end |
| `editnce-cli` | Every command by job, JSON shapes, error codes → recovery |
| `editnce-registry` | Search before building; installing/wiring blocks, components, SFX; theming via vars |
| `editnce-motion` | `data-fc-motion` reference + GSAP-as-code rules for seekable video |

### 6.2 `editnce-footage` — required contents
`SKILL.md` (≤ 250 lines) = the procedure; details in `references/`:

1. **Procedure:** resolve style → probe → transcribe → cuts → scaffold (or edit existing)
   → overlays → sound → look → `check` → `snapshot --contact-sheet` + targeted
   snapshots at every overlay entry → fix → `render --draft` → user review → final render.
2. `references/cutting.md` — dead air rules (gap thresholds, never clip word starts,
   lead/tail padding rationale), fillers, cutting by phrase ("cut the part where…":
   find words in transcript, `--drop` the source range), keeping breaths natural,
   jump-cut hiding with alternating punch-in scale, end padding.
3. `references/captions.md` — caption models: one word at a time, short phrases
   (2–4 words), full-line subtitles; placement relative to the face (never over the
   face; chest-level default for 9:16 talking heads; lower-third for 16:9); size and
   weight vs frame height; contrast (shadow vs box); highlighting key words by
   *meaning* (style.md decides colors); timing from `cuts.json` words; when footage
   already has burned-in captions.
4. `references/overlays.md` — cards, pills, stat callouts, lower-thirds, CTAs; the
   **face-safe zone** (find the face box: sample frames and ask the agent to look,
   or MV8 person mask bbox when available); keep overlays in empty space; read time
   (≈ 0.3 s per word, min 1.2 s); entry/exit motion budgets (in ≤ 0.25 s); alert/danger
   states; anchoring an overlay to a word (`compStart` of that word − 0.1 s).
5. `references/zooms-and-pacing.md` — punch-in zoom per cut/sentence, bigger zoom on
   key moments, hook zoom-out, never zoom so far the face clips; scroll-stopping first
   3 s (hook card within 0.15 s, flash, impact sound); total length discipline.
6. `references/sound.md` — SFX vocabulary (whoosh = scene change, pop = element in,
   click, error, impact/bass on big moments, riser before reveal); levels 0.3–0.45 of
   voice; never stack more than 2 at once; music bed ducking (volume + fades);
   loudness target −14 LUFS for social.
7. `references/look.md` — light grade via CSS filter on the footage clip
   (`brightness/contrast/saturate`) or the `grade` component; vignette; why not
   heavy filters (render cost); matching overlays to footage tone.
8. `references/review.md` — how to inspect snapshots: face covered? text cut off? text
   readable at phone size (view the contact sheet at 360 px wide)? overlays inside the
   frame? (a real bug we shipped: cards overflowed the right edge because
   `box-sizing` was not `border-box` — always set `* { box-sizing: border-box }`).
9. `references/style-file.md` — §5.3 protocol verbatim plus examples of turning
   feedback into style entries.
10. `references/formats.md` — 9:16 / 16:9 / 1:1 sizes, safe zones per platform
    (Reels/TikTok UI overlays bottom ~20% and right ~12%), `object-fit: cover` vs
    reframing.

Topics checklist from HyperFrames (read, don't copy): `skills/hyperframes/references/
{captions,overlays,motion,sound,look,review,format}.md`,
`skills/media-use/audio/references/{transcribe,sfx,remove-background,tts}.md`,
`.agents/skills/{captions-overlay,motion-doctrine,seam-craft}/SKILL.md`.

### 6.3 Install
`editnce skills update` (09 §3) installs into `.claude/skills`, `.agents/skills`,
`.cursor/skills`, `.codex/skills` of the project, or `~/.claude/skills` etc. with
`--global`. `editnce init` also writes a project `AGENTS.md` + `CLAUDE.md`
(identical) that point the agent at the skills and the style file.

---

## 7. MV4 — Neutral blocks + SFX library

### 7.1 Block rules
- Neutral defaults: white/near-black, system sans (`Inter` if a local font file is
  bundled with the block — do not rely on network fonts), no brand colors.
- **Every visual decision is a CSS custom property** declared in `block.json` `vars`
  with default + description, e.g. `--fc-card-bg`, `--fc-card-radius`,
  `--fc-accent`, `--fc-caption-size`. The agent themes blocks from style.md by
  setting vars on the host element.
- Animation uses `data-fc-motion` (so Studio can edit it); no GSAP in first-party
  blocks.
- Each block ships `index.html` (a standalone composition that passes `check`),
  `block.json`, `preview.mp4` (rendered in CI), and a `snippet.html` showing how to
  wire it into a host composition.
- Extend `block.json`: `{ name, type, version, description, tags, vars: {name:
  {default, description}}, slots: [{name, description}], files, example }`.

### 7.2 First-party blocks for footage editing (build all)
| Name | What | Key vars / slots |
|---|---|---|
| `word-captions` | one-word-at-a-time captions; generator fills from `cuts.json` words | size, weight, color, accent, shadow, y-position, pop scale; `data-accent-words` |
| `phrase-captions` | 2–4 word cards with active-word highlight | max words, highlight color, box on/off |
| `subtitle-line` | classic 1–2 line subtitles | box opacity, max chars |
| `card` | glass/solid card with optional pill + title + body | bg, border, blur-free glass toggle, radius, width, pill text/color |
| `pill` | status pill | color variants via `--fc-pill-*` |
| `alert-card` | card variant with glow + shake motion | danger color |
| `stat-card` | giant number/text | number color, size |
| `lower-third` | name + title bar | colors, side |
| `cta` | follow/subscribe end pill | text, color |
| `flash` | 2–3 frame white (or color) flash transition | color, frames |
| `zoom-transition` | punch/zoom-through between segments | scale |
| `grade` | footage look: brightness/contrast/saturation + vignette + top/bottom darken | each value |
| `progress-bar` | thin progress line | color, position |
| `title-card` | full-frame title with word stagger | colors, font size |
Motion presets (registry type `motion-preset`, see 11 §): `pop-in`, `drop-in`,
`shake`, `punch-zoom`, `zoom-out-hook`, `word-stagger`.

`editnce add word-captions --from cuts.json` must generate the per-word spans
(each `<span data-start data-end data-word-id>`) from the cuts file so the agent does
not hand-write hundreds of spans. Performance note: 150+ timed spans is fine for the
runtime; the render plan must not shard on them (already fixed — see STATUS §3).

### 7.3 SFX library
- Location: `registry/sfx/<name>/{sfx.json, <name>.wav, <name>.mp3}`;
  `sfx.json = {name, type:"sfx", description, tags, duration, license, source, author, sha256}`.
- **Licensing (hard):** only (a) sounds we synthesize ourselves, or (b) CC0 sources
  that allow redistribution (e.g. Kenney.nl audio packs, Freesound items explicitly
  CC0 — record the URL). **Do not** bundle Pixabay-licensed files (their license
  forbids redistributing files on a standalone basis). Keep `registry/sfx/LICENSES.md`.
- Synthesized set (write `scripts/sfx/synth.mjs` using ffmpeg `aevalsrc`/`anoisesrc`
  + filters; commit both the script and outputs): `whoosh-short`, `whoosh-long`,
  `pop`, `click`, `tick`, `swish`, `riser`, `impact-bass`, `thud`, `error-buzz`,
  `success-chime`, `notification`, `glitch`, `typing-loop`, `camera-shutter`.
  Each: 48 kHz, peak −1 dBFS, trimmed silence, ≤ 2 s (riser ≤ 3 s). Agent-facing
  descriptions say *when* to use each.
- Install: `editnce add sfx/pop` → copies to `assets/sfx/pop.mp3` and prints
  `<audio src="assets/sfx/pop.mp3" data-audio-offset="T" data-volume="0.4"></audio>`
  wiring guidance (inside a timed holder element with `data-role="audio"`).
- Studio Assets panel lists SFX with play buttons; drag onto the timeline at the
  playhead creates the holder + audio element.

---

## 8. MV5 — `@editnce/sdk` + MCP server

### 8.1 SDK (`packages/sdk`)
One in-process API that CLI commands, studio-server, the built-in agent, and the MCP
server all call (no shelling out between our own packages):
```ts
openProject(dir): Project
project.readFile/writeFile/editFile(path, old, new)       // scoped to project root
project.timeline(): Timeline
project.check(): CheckResult
project.snapshot(times, opts): {t, path}[]
project.contactSheet(n, width): path
project.render(opts, onProgress, signal): RenderResult
project.transcribe(media, opts) / cuts(opts) / scaffoldFootage(opts)
project.catalog(query) / add(name, opts)
project.style(): {path, content} | null; project.updateStyle(section, text, decision)
project.history.snapshot(label) / restore(id)              // file-level undo (§9.4)
```
Every write returns a lint summary (errors/warnings count + first 10 findings).

### 8.2 MCP server — `editnce mcp [dir]`
Stdio MCP server exposing the SDK as tools (names: `fc_timeline`, `fc_read`, `fc_write`,
`fc_edit`, `fc_check`, `fc_snapshot` (returns images), `fc_render`, `fc_transcribe`,
`fc_cuts`, `fc_scaffold_footage`, `fc_catalog`, `fc_add`, `fc_style_read`,
`fc_style_update`). Lets Claude Code/Cursor/Codex vibe-edit with structured tools and
image returns. Use the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`);
pin a release that is ≥ 7 days old. Document setup lines for Claude Code and Cursor in
the skill. (HyperFrames exposes Studio actions to agents via WebMCP in
`packages/studio/src/webmcp/`; read for ideas.)

### 8.3 "Copy prompt for your agent"
Studio button that composes a ready-to-paste prompt (project path, brief, style file
path, the skill names, current selection/playhead) — useful for users who prefer an
external agent. Reference HF `packages/studio/src/components/sidebar/PromptPreviewModal.tsx`.

---

## 9. MV6 — Studio vibe-edit chat (built-in agent)

The flagship for non-developers. Build on `09 §4` (provider, tools, loop, guardrails);
this section pins down what is specific to vibe editing and the web app.

### 9.1 Architecture
```
Studio UI (browser)  ──POST /api/agent/turn──▶ studio-server ──▶ @editnce/agent loop
        ▲                                          │                 │ tools = SDK calls
        └──── SSE /api/agent/stream/:turnId ◀──────┘                 ▼
                     (text deltas, tool events, snapshots)     project files
        ▲
        └──── WS file-changed ── preview iframe reloads at the same playhead
```
- Agent runs **server-side in studio-server's Node process** (keys never reach the
  browser).
- Provider: Anthropic first via `@anthropic-ai/sdk` (pin a release ≥ 7 days old;
  model id configurable, default a current Sonnet-class model). Interface per 09 §4.1
  so OpenAI/local can follow.
- Key: `ANTHROPIC_API_KEY` env, or `~/.config/editnce/config.json` (`0600`), or the
  cloud proxy later (12 §6). Missing key → chat panel shows setup instructions, plus
  the "Copy prompt for your agent" fallback (§8.3).

### 9.2 System prompt assembly (per turn)
1. `skills/editnce/SKILL.md` + `skills/editnce-footage/SKILL.md` (full) and the
   reference file *index* (the agent loads references with `read_skill_reference`).
2. Resolved `style.md` (full) or "no style file".
3. Project context: `editnce.json`, composition list, compiled timeline summary
   (≤ 60 clips; else grouped), transcript summary (duration, word count, first 400
   words), cuts summary, current selection (element id + outer HTML ≤ 2 KB), playhead.
4. Rules: §0 hard rules, the loop (§1), "always check + snapshot before finishing",
   style protocol (§5.3).

### 9.3 Tools
SDK tools from §8.1 plus: `ask_user {question, options?}` (UI renders buttons),
`read_skill_reference {skill, file}`, `seek_preview {t}` (moves the user's playhead
so they see what the agent is talking about). Snapshots return images to the model.
Limits: 40 tool calls/turn, 3 consecutive failed checks → stop and report.
Confirmation required (UI button) for: full render > 60 s of output, model
downloads, anything with paid API cost. Draft renders and snapshots are auto-approved.

### 9.4 Undo & safety
- Before the first write in a turn: `history.snapshot("turn <n>: <first 60 chars of
  user msg>")` copies all project text files (not media) into
  `.editnce/history/<id>/`. "Undo turn" restores them atomically and reloads.
- All paths resolved and checked to be inside the project root.
- Agent never modifies `assets/raw/`.

### 9.5 UI (right dock panel "Agent")
- Message list with streaming markdown; collapsible tool-call chips (name + 1-line
  summary, expandable JSON); inline snapshot thumbnails (click → seek preview).
- Composer: textarea, send (Enter), stop (aborts loop via AbortSignal), "attach
  selection" toggle (default on when something is selected).
- Footer: style file chip (click opens Style panel), token/cost counter for the turn.
- Starter prompts when the project is empty: "Cut the dead air and add captions",
  "Make this a 9:16 reel", "Add a title card", "Add subtle sound effects".
- After the agent finishes: show summary + "Undo turn" + "Render draft" buttons.

### 9.6 Acceptance
- Fake-provider scripted test: a fixed sequence (transcribe → cuts → scaffold → add
  word-captions → check → snapshot) produces a project that passes check; undo turn
  restores the pre-turn files byte-for-byte.
- Path-escape test: tool call with `../` path is rejected.
- Real-provider smoke (env-gated): fixture talking-head clip + brief from §0 produces a
  passing check and a draft render; second turn "make captions yellow and always do
  that" changes the captions and writes a style.md decision row.
- Preview updates within 1 s of each agent write without losing playhead.

---

## 10. MV7 — Render speed for the feedback loop

Measured (STATUS §3): 42 s, 1080×1920, 1265 frames, screenshot mode (macOS, no
beginFrame), 4 workers → **11 min 18 s**. Basic 640×360 2 s fixture → 4.7 s. This is
too slow for iterative vibe editing.

1. **Measure first.** Add `--profile` to render: per-frame timings for seek,
   overlay image load, ready wait, capture, encode write; summary p50/p95 per stage
   and per worker; write `.editnce/render-profile.json`. Do not optimize before
   this exists.
2. **Draft mode** (`--draft`): render at 0.5 scale via `deviceScaleFactor` or a
   CSS-scaled viewport, JPEG q70, preset `veryfast`. Target: ≤ 3 min for the reference
   42 s reel on an Apple-silicon Mac.
3. **Overlay preloading:** the runtime should decode the next frame's video images
   while the current frame is captured (`img.decode()` on a hidden buffer image,
   swap on seek). Target: overlay load ≈ 0 in steady state.
4. **Ready-wait tightening:** `waitReady` currently does fonts + images + double rAF
   every frame; skip font wait after the first frame unless fonts changed; resolve
   images only for those whose `src` changed this frame.
5. **Worker auto-sizing** (§4.6) and verify scaling (1/2/4/6 workers) with the profile.
6. **Linux beginFrame:** run the render-worker Docker image on Linux, confirm the
   probe passes and record speed. The engine already supports it.
7. **Studio preview never needs a render** — make sure the live preview (iframe +
   runtime + `<video>` playback) is good enough that users render only to export.
8. Later: incremental re-render (14 §3) keyed on segment hashes.
Acceptance: profile JSON exists; draft and full targets met on the reference project
or a documented explanation with numbers.

---

## 11. MV8 — Background removal

Command `editnce remove-background <in> -o <out.webm|out.mov|out.png>
[--model u2net|modnet] [--quality fast|balanced|best] [--device auto|cpu|coreml|cuda]
[--background-output plate.webm] [--json]`, plus a Studio inspector button on a
selected video/image clip (runs as a job with progress, then swaps `src` to the
output and keeps the original in `assets/raw/`).

1. **Prerequisite:** MV0.2 alpha frame extraction (otherwise cutouts render black).
2. **Pipeline:** ffmpeg decode → raw RGB frames (pipe) → model inference
   (`onnxruntime-node`, CoreML EP on macOS, CUDA EP when present, CPU fallback) →
   mask → temporal smoothing (EMA α≈0.6 on the mask, reset on scene cut) → edge
   refinement (guided filter using the full-res frame as guide) → compose alpha →
   ffmpeg encode: WebM `libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0`, or ProRes 4444
   `prores_ks -profile:v 4444 -pix_fmt yuva444p10le`, or PNG for images. Optional
   inverse-alpha background plate.
3. **Model bake-off (do this before committing to a default):** on a 5 s talking-head
   clip, produce frames with (a) `u2net_human_seg` (Apache-2.0, what HyperFrames uses:
   `packages/cli/src/background-removal/manager.ts`, 320×320 input, no temporal
   smoothing), (b) MODNet portrait matting (verify Apache-2.0 license of the ONNX
   weights you use), (c) the winner + smoothing + guided filter. Compare edge quality
   on hair/beard/glasses and flicker (mean absolute mask delta between consecutive
   frames on a static subject). Record results and the choice in `plan/DECISIONS.md`.
   Exclude non-commercial models (RMBG-1.4/2.0) and GPL ones (Robust Video Matting).
4. Models download on first use to `~/.cache/editnce/models/` with pinned URL +
   sha256.
5. Dependencies: `onnxruntime-node`, `sharp` — pin versions published ≥ 7 days ago.
Acceptance: image fixture IoU ≥ 0.9; video fixture flicker metric below the
U²-Net baseline; Studio button round-trip works; alpha output composites correctly in
a render.

---

## 12. MV9 — TTS

`editnce tts "<text>" [--voice] [--provider kokoro|say|elevenlabs|openai] [-o out.wav] [--json]`
returning `{path, duration, words}`.
- Default local provider: **Kokoro-82M** (Apache-2.0), which HyperFrames uses
  (`packages/cli/src/commands/tts.ts`, `packages/cli/src/audio/providers.ts` —
  they run it via the Python `kokoro-onnx` package). Prefer a Node path
  (`onnxruntime-node` + Kokoro ONNX + a JS phonemizer) if one is reliable; otherwise
  document the Python dependency and have `doctor` check it.
- Fallback: macOS `say` (free, robotic). Paid: ElevenLabs (word timestamps), OpenAI.
- Word timings: provider-native when available; else run `transcribe` on the output.
- Studio: "Voiceover" action in the chat starter prompts and an Audio panel entry.

---

## 13. MV10 — Vibe-edit eval suite & end-to-end acceptance

`evals/vibe/` with 10 briefs over 3 fixture clips we are allowed to commit (record
our own short talking-head clips or use CC0 footage; ≤ 20 s each, store with
Git LFS or download script + sha256). Example briefs:
1. "Cut the dead air and add one-word captions" (9:16).
2. "16:9 YouTube cut with lower-third name card and subtitles."
3. "Make a reel: hook title, captions, a stat card when I say the number, SFX."
4. Same as 3 with a provided `style.md` (assert style tokens applied: caption color,
   card position, zoom present).
5. Feedback turn: "captions bigger and always do that" (assert caption size grew and
   style.md has a new decision row).
Scoring per run (headless, real model, nightly): check passes (30%), render succeeds
(20%), cuts correct — no word truncated, removed ≥ 80% of gaps > 0.5 s (15%),
style adherence (15%, rule-based where possible), LLM-judge rubric on the contact
sheet: face never covered, text readable, overlays inside frame (20%). Track over
time; skill changes must not regress the mean. Target ≥ 70% before calling the track
done.

**Track acceptance (all must hold):** §0 "done looks like" scenario passes in Studio
chat with a real model; the same brief passes via `editnce mcp` from Claude Code;
no file under `packages/` or `skills/` contains a creator-specific style value (grep
review); eval mean ≥ 70%.

---

## 14. HyperFrames reference map (read-only, `_analysis/hyperframes-src/`)

| Topic | Where |
|---|---|
| CLI rules for agents (stdout/stderr, exit codes, JSON envelope) | `packages/cli/AGENTS.md`, `src/utils/jsonError.ts`, `src/cli.agentMode.test.ts` |
| doctor | `packages/cli/src/commands/doctor.ts` |
| transcribe + whisper model management | `packages/cli/src/commands/transcribe.ts`, `src/whisper/manager.ts` |
| tts (Kokoro) | `packages/cli/src/commands/tts.ts`, `src/audio/providers.ts` |
| remove-background | `packages/cli/src/commands/remove-background.ts`, `src/background-removal/*` |
| alpha-aware frame extraction | `packages/engine/src/services/videoFrameExtractor.ts` |
| screenshot vs beginFrame flags | `packages/engine/src/services/browserManager.ts` (`BEGINFRAME_ONLY_FLAGS`) |
| worker sizing + frame distribution | `packages/engine/src/services/parallelCoordinator.ts` |
| Studio agent tools (WebMCP) | `packages/studio/src/webmcp/` |
| "copy prompt for your agent" | `packages/studio/src/components/sidebar/PromptPreviewModal.tsx` |
| editing craft topics | `skills/hyperframes/references/*.md`, `skills/media-use/**`, `.agents/skills/*` |

Rules from `AGENTS.md` apply: write our own code; attribute any snippet > ~15 lines;
never use their names in our product.
