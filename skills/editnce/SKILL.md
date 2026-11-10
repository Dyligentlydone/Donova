---
name: editnce
description: Router for all Editnce video work — read FIRST for any request to make, edit, caption, re-cut, restyle, or render a video, animation, motion graphic, talking-head edit, or composition. Tells you which skill/workflow handles the request and which CLI to run. Use for Editnce, `editnce`, `ec`, .html compositions, data-ec-motion, window.__timelines, or any vibe-editing session.
---

# Editnce

Editnce renders an HTML composition to video: a static page with
`data-*` timing attributes, rendered frame-by-frame through headless Chrome
and muxed to MP4/WebM by FFmpeg. An edit IS code — you work by writing and
editing `index.html`, then validating with `editnce check` and rendering.

## The work loop — never skip steps

1. **Understand the project.** `editnce timeline . --json` → clips, timing,
   media. `editnce probe <media> --json` → media facts. If `style.md` exists
   in the project (or `editnce style path` resolves one), READ IT FIRST — it
   holds the user's taste.
2. **Edit the composition** (write/edit `index.html`, add blocks, apply cuts).
3. **`editnce check --json`** → must be 0 errors before you continue.
4. **LOOK at it.** `editnce snapshot --times T,T,T --contact-sheet sheet.png`
   → open the image and actually inspect framing, overflow, caption legibility.
   If something looks wrong, fix and re-check. Never claim done without this.
5. **Render** (`editnce render --out out.mp4`, `--draft` for a fast pass).
   Only render after check is clean and you've eyeballed a snapshot.

## Which skill for which job

- **Footage editing** — user gives a video/audio file + natural-language
  instructions ("cut the pauses, add captions, make it moody"): read
  `editnce-footage` — the transcript → cuts → scaffold → blocks loop.
- **CLI reference** — every command's flags, JSON output shapes, exit codes,
  error codes: `editnce-cli`.
- **Named visual / ready-made piece** — caption style, card, lower-third,
  transition, SFX: `editnce-registry` — search before hand-building.
- **Animation detail** — `data-ec-motion` keys, easings, presets, GSAP code
  authoring, seek-safety rules: `editnce-motion`.

## Hard rules

- Never edit `data-ec-motion` output into GSAP code or vice versa — they are
  two different animation paths; pick one per element.
- Deterministic only: no `Date.now()`, `Math.random()`, `fetch()` to the
  network, `setInterval`, or wall-clock rAF inside compositions.
- Elements that animate in time need `data-start` + a duration; full-screen
  scene containers also take `class="clip"`.
- Card/overlay text must sit INSIDE the composition bounds — after writing,
  snapshot and check for overflow before rendering (right-edge overflow is the
  most common defect).
- `editnce check` must pass with 0 errors before `editnce render`.
