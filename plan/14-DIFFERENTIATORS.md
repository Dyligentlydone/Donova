# 14 — Differentiators (how we beat the reference product)

HyperFrames is HTML-first and developer/agent-first. Our users are creators who start from
**their own footage**. These features are built on the same contract (everything still
compiles to plain compositions), so they stay renderable, editable, and agent-friendly.

## 1. Footage-first editing

### 1.1 Transcript (text-based) editing
- Studio "Transcript" panel shows `transcript.json` words for the selected video clip (or all A-roll).
- Select words → Delete → produces cuts. Model: an **edit decision list** stored on the
  video as split clips — each kept range becomes its own `<video>` element with
  `data-media-start` and `data-duration`, placed back-to-back (`data-start="<prev id>"`),
  ids `talk-s1`, `talk-s2`… Linked audio comes from each segment (`data-has-audio`).
- Overlays anchored to words (`data-anchor-word="<wordIndex>"`) are re-timed automatically
  when cuts change: `anchor time = mapSourceTimeToTimeline(word.start)`.
- Undo works because each operation is one mutation group.
- Micro-crossfade on audio at each cut (10 ms `afade` both sides; implement as automatic
  fade-in/out 0.01 on segment clips) to avoid clicks.

### 1.2 Silence & filler removal
`editnce cut --silence --fillers --padding 0.08 --min-gap 0.25` / Studio button:
1. Silence ranges (10 §6) ∪ filler words (10 §2) → removal ranges (shrink by padding).
2. Merge ranges closer than min-gap; never cut inside a word.
3. Preview diff in Studio (struck-through words) → Apply → transcript cut mechanism (§1.1).
Acceptance: 60 s fixture with 8 s of silence → output ≈ 52 s ± 0.5, no word truncated (transcribe output again; word sequence equals expected).

### 1.3 Auto-reframe (16:9 → 9:16 / 1:1)
1. Sample frames at 5 fps; detect faces/person with an ONNX face detector (e.g. YuNet or BlazeFace; check licenses) → bounding boxes.
2. Choose subject (largest/most persistent track; diarization speaker if multicam).
3. Compute crop-window center path; smooth with a critically damped spring / Savitzky–Golay; hold still when motion < threshold (no jitter); hard cut the crop on scene cuts (scene detection `select='gt(scene,0.35)'`).
4. Emit as GSAP keyframes on the video's `object-position` (or a wrapper transform) at 5 keys/s, simplified with Ramer–Douglas–Peucker.
Acceptance: fixture with a person walking across frame stays within the center 60% of the 9:16 crop on 95% of frames.

### 1.4 Multicam sync
Align multiple recordings by audio cross-correlation (downsample to 8 kHz, FFT xcorr on first 60 s) → offsets → set `data-media-start` per angle. Switch angles by active speaker (energy per mic) or manual cuts.

### 1.5 Smart B-roll
From transcript keywords/noun phrases (LLM extraction) → stock search (10 §7) → suggestions placed on a b-roll track at the matching words; user accepts/rejects per suggestion.

### 1.6 One-click packages
"Make it social": captions (style from Style Bible) + silence removal + reframe 9:16 + hook title in first 2 s + progress bar + loudness −14 LUFS + end card. Implemented as an agent workflow with deterministic steps (no LLM needed except hook title).

## 2. Style Bible engine

> **Updated by 17 §5:** the primary "my style" mechanism is now the **user-owned
> `style.md`** that the agent reads before editing and updates from feedback. The
> analyzer and `style.json` below are an optional later feature that can *propose*
> entries for `style.md`; they must never override user-written entries.

Turns "edit it in my style" into data.

### 2.1 Analyzer (`editnce analyze-style refs/*.mp4 --out style.json`)
Per reference video:
- **Cuts / pacing**: scene detection → shot lengths → median, p10, p90, cuts per minute; pacing curve over time (hook speed vs body).
- **Captions**: sample 2 fps, OCR (tesseract.js or ONNX PaddleOCR) on the lower 60% → caption presence %, position (normalized y), words per card, size relative to frame height, casing (UPPER ratio), color clusters (text + stroke/box), highlight behaviour (color changes within a card across frames).
- **Typography guess**: classify caption font into families (geometric sans / grotesk / serif / rounded / condensed / handwritten) with a small classifier on glyph crops; map to closest Google Font.
- **Color**: k-means (k=6) on downsampled frames → palette; average saturation, contrast, warmth → suggested look.
- **Audio**: integrated LUFS, music presence (spectral flatness + vocal-band energy), VO-to-music ratio, SFX density (transients).
- **Framing**: face size relative to frame (from 1.3 detector), zoom/punch-in frequency (scale changes between consecutive shots of the same subject).
- **Motion graphics**: frequency of text overlays not matching transcript (titles), emoji usage.
Aggregate across refs (median), with confidence per token.

### 2.2 `style.json` (schema in contract)
```json
{
  "version": 1,
  "tokens": {
    "pacing": { "medianShotSec": 1.8, "cutsPerMin": 28, "hookCutsPerMin": 40, "confidence": 0.8 },
    "captions": { "enabled": true, "style": "bold-pop", "position": 0.68, "wordsPerCard": 3, "case": "upper", "fontFamily": "Montserrat", "weight": 800, "color": "#FFFFFF", "highlight": "#FFD400", "stroke": "#000000", "sizePct": 0.055 },
    "color": { "look": "warm", "palette": ["#..."], "intensity": 0.6 },
    "audio": { "targetLufs": -14, "music": true, "musicDuckDb": -14, "sfx": "light" },
    "framing": { "punchInEvery": 6, "punchInScale": 1.12 },
    "graphics": { "hookTitle": true, "progressBar": false, "emoji": false }
  },
  "decisions": [{ "date": "2026-11-06", "token": "captions.case", "value": "upper", "source": "user" }]
}
```
Plus human-readable `STYLE.md` generated from it. Tokens marked `source: analyzer | user`;
user-confirmed tokens are never overwritten by re-analysis.

### 2.3 Application
- Agent system prompt includes style tokens; workflows read them (captions generator uses `captions.*`, silence removal uses pacing, auto punch-ins every `framing.punchInEvery` s at sentence boundaries).
- Studio "Style" panel: view/edit tokens, "re-apply style to this project".
Acceptance: analyzer on 3 fixture refs with known caption style returns correct position (±0.05), case, wordsPerCard (±1), and pacing (±15%).

## 3. Incremental re-rendering
- Partition the timeline into **segments** at scene boundaries (root-level clips/sub-comps that don't overlap) — or fixed 2 s windows if none.
- Segment hash = sha256(compiled HTML of everything visible in the window + asset hashes + render options + engine version).
- Cache encoded segment chunks (closed GOP) in `.editnce-cache/segments/<hash>.mp4`.
- Re-render: only segments whose hash changed are captured; concat with cached chunks; audio always re-mixed (cheap).
Acceptance: change text in scene 3 of a 5-scene 60 s project → re-render captures only scene 3 frames (log) and output equals a full re-render (frame hash).

## 4. Draft renders in the browser (no server)
- Short-term (v1): Studio "Quick export" = local studio-server render with `draft` quality and 0.5× scale (fast).
- Experimental (v2): in-browser capture using Chrome's HTML-in-canvas / `drawElementImage` API when available (feature-detect), frames → WebCodecs `VideoEncoder` (H.264) → mux with `mediabunny` → MP4 download. Fallback to server. Gate behind a flag; verify parity PSNR ≥ 35 dB against producer.

## 5. Simplicity & UX wins
- 5 core CLI verbs for humans (`init`, `preview`, `check`, `render`, `add`); everything else under `editnce tools …` (aliases kept).
- Plain-language errors everywhere with a "Fix it for me" button in Studio that sends the finding to the agent.
- Templates are real, beautiful, and tested (CI renders every template).

## 6. Templates marketplace (later)
Creators publish blocks/templates to the registry with pricing; buyers install into projects; revenue share via Stripe Connect. Requires licensing per item and DRM-lite (signed downloads; source still editable once purchased).
