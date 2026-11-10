---
name: donova-footage
description: Edit raw footage (talking head, interview, vlog, screen capture, b-roll) with Donova — the transcript→cuts→scaffold→blocks→check→snapshot→render loop. Use whenever a user gives a video/audio file plus natural-language instructions, asks to cut pauses/fillers, add captions, apply a style, re-cut an episode, or "vibe edit". Also covers style.md handling, caption design, overlays, punch-ins, SFX, and the frame-review loop.
---

# Footage editing

This is the core vibe-editing loop: the user drops raw media and describes
the result they want. You do the whole edit through tools — never guess at
timings when a transcript is available.

## The pipeline

```
media → transcribe → cuts → scaffold → blocks/style → check → snapshot → render
```

1. **`donova transcribe <media> --json`** → `transcript.json` (word-level
   timestamps). If the file exists already, reuse it. Default engine `auto`
   runs NVIDIA Parakeet (best accuracy); `--engine whisper` forces whisper.cpp.
   When you know the names/jargon in the audio (brands, products, speakers),
   pass `--prompt "Fiverr, Dyligent"` — it biases recognition and stitches
   fragment-spelled terms back together.
2. **`donova cuts transcript.json --json`** → `cuts.json` — dead air
   removed at word boundaries. Tune with `--threshold` (silence gap, default
   0.35s) and `--pad` (breathing room, default 0.06s). Read the user's ask:
   "cut the pauses" → defaults; "keep some air" → `--threshold 0.8`.
3. **`donova scaffold <media> --cuts cuts.json --width W --height H --json`**
   → neutral `index.html`: one `.clip` per kept segment, `data-media-start`
   trims, cover-crop to the output frame. Nothing else — no captions, cards,
   or grade. That's your blank canvas.
4. **Apply the ask + style.** Read `style.md` if present (see below). Install
   blocks for anything named (captions, cards, lower-thirds, SFX) rather than
   hand-building: `donova catalog`, `donova add <name>`.
5. **`donova check --json`** → fix every error.
6. **`donova snapshot --times ... --contact-sheet sheet.png` → LOOK.**
   Choose times that cover: first frame, a caption mid-video, any card/overlay,
   a scene cut boundary, the last frame. If text overflows, captions sit on the
   face, or the framing is wrong — fix and re-snapshot.
7. **`donova render --out out.mp4`** (`--draft` first for a fast look,
   `--range a-b` to check one section, `--workers auto` on big renders).

## style.md — the user's taste lives in a file, not in you

- Resolution: `<project>/style.md` → `<project>/STYLE.md` →
  `~/.config/donova/style.md` (`donova style path` resolves it).
- READ it before editing; it overrides your defaults. Conflicting instruction
  in the same request beats the file for THIS edit, but if the user corrects
  you in a lasting way ("always do X", "never Y", or the same correction twice),
  UPDATE the file (see below) so the next edit remembers.
- If none exists and the user describes a look, offer to save one:
  `donova style init` scaffolds an empty guide.
- The app ships NO built-in style. Do not write your own aesthetic into the
  composition as if it were a framework rule — everything you choose goes in
  the user's file or in the composition itself.
- Updating: append to the relevant `##` section in the user's words; never
  rewrite sections you didn't create; keep it short and directive.

## Cutting footage (references/cutting.md)

- Silence removal: `donova cuts` — gaps > threshold at word boundaries.
- Filler words ("um", "like"): find them in the transcript, cut by inserting
  cut-plan segment boundaries — split segments so the filler word is excluded.
- By-content cuts: search `transcript.json` words for the phrase, map its
  source time → segment boundary via the cuts plan (`compStart` mapping is in
  `cuts.json`).

## Captions (references/captions.md)

- One-word-at-a-time kinetic captions are the default for talking heads;
  phrase captions for interviews. Use the `word-captions` block — it generates
  timed caption elements from transcript+cuts, with `data-fc-motion` pop.
- Emphasis: the block marks danger/emphasis words via a `--emphasis` word
  list; the user's style.md may also declare accent colors/words.
- Placement: captions live in the lower-middle safe zone by default — never
  over the face; check the subject position in snapshots before committing.

## Overlays, punch-ins, cards (references/overlays.md)

- Punch-in zooms between cuts: per-segment `data-fc-motion` scale 1.0→1.1 or
  a small jump at the cut — the `zoom-transition` block or motion presets.
- Cards/alerts: install `card`, `alert-card`, `stat-card` blocks; keep them
  inside frame bounds (snapshots!). Reserve card time for words that matter.
- Safe zones: keep text ≥ ~8% from edges; platform UI covers the right edge
  and bottom — verify with a snapshot.

## SFX + music (references/audio.md)

- `donova add sfx/<name>` drops a licensed SFX into `assets/sfx/` — play
  hits on beat moments: scene changes, card pops, emphasis words.
- Music bed: `<audio src>` under everything, `data-volume` 0.15–0.3,
  `data-audio-fade-in/out`. Duck under voice by keeping volume low — no
  sidechain needed for v1.

## The look (references/look.md)

- Grade as a full-frame overlay `<div class="clip">` with CSS
  `filter`/`mix-blend-mode`, or per-clip filters — subtle unless style.md says
  otherwise. Vignette via a radial-gradient overlay.
- Reframing 16:9 → 9:16: scaffold with `--width 1080 --height 1920` cover-crops
  centered; if the subject is off-center (snapshot check!), adjust the
  `.clip video` left offset — face the subject, not the geometry.

## Before you say done

- `check` is clean (0 errors), a contact-sheet snapshot looked right, the
  audio is present (`probe` the render), and duration/matches the cuts plan.
- Report: what you cut, what you added, where the output file is, and the
  one-line render command to reproduce it.
