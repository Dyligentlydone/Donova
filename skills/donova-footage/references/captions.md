# Captions

## Block: `word-captions` (preferred)

`donova add word-captions` installs the block, then generate caption
elements from the transcript + cuts:

```bash
donova add word-captions
# then run the generator — it rewrites captions inside the composition
donova captions --transcript transcript.json --cuts cuts.json \
  --mode word --out-caption-track
```

If the `captions` command isn't available in this build, generate spans in
index.html directly with this pattern:

```html
<div class="clip" data-start="0.62" data-duration="0.34">
  <span class="cap" data-fc-motion='{"v":1,"anims":[{"t":0,"dur":0.18,"ease":"back.out(2)","props":{"scale":[0.6,1],"opacity":[0,1]}}]}'>word</span>
</div>
```

- `data-start` = compStart + (word.start − srcStart) — map source time to
  comp time through the cuts plan's segments.
- `data-duration` = word.end − word.start (clamp ≥0.12s so fast words read).
- One element per word; consecutive words replace each other.

## Phrase captions

Group words into 2–5-word phrases ending at natural pauses (punctuation or
≥0.3s gaps). Same timing math; set `--mode phrase` in the generator.

## Position and safe zones

- Default anchor: lower-middle, ~62–72% down the frame, centered — the
  "chest zone" under a talking head. Never over the face itself.
- Keep ≥8% margin from left/right edges; platform UI eats the right ~15% and
  bottom ~12% on vertical platforms.
- Words that must be readable need ≥0.12s on screen; merge ultra-short words
  ("a", "the") with the next word if they'd flash.

## Emphasis

- `--emphasis "scam,fishy,zero"` on the generator (or a style.md word list)
  gives those words the emphasis class — color/transform comes from the
  block's variables (`--cap-accent`), never hard-coded.
- Danger words in red, key phrases in accent color — only when style.md or
  the user asks; default is a single accent color from the block.

## Legibility checklist (verify in a snapshot!)

- Contrast against the footage: white text needs a stroke, shadow, or pill
  background on light footage.
- Nothing important sits under platform UI zones.
- The caption isn't colliding with a card/overlay active at the same time —
  check the contact sheet at overlapping times.
