# Cutting footage

## Dead-air removal (the common case)

`editnce cuts transcript.json` emits a `cuts.json` plan:

```json
{
  "version": 1, "source": "a-roll.mp4",
  "silenceThreshold": 0.35, "pad": 0.06,
  "sourceDuration": 47.8, "duration": 41.8, "removed": 6.0,
  "segments": [
    { "srcStart": 0.0, "srcEnd": 8.82, "compStart": 0.0,
      "duration": 8.82, "wordStart": 0, "wordEnd": 33 }
  ]
}
```

- `srcStart/srcEnd` — seconds in the SOURCE file.
- `compStart` — where that piece lands on the OUTPUT timeline.
- Segments are contiguous: no gaps on output.
- `wordStart/wordEnd` — inclusive index range into `transcript.words`.

Tune: `--threshold` (bigger = keep longer pauses), `--pad` (keeps breaths at
cut points — 0.04–0.1 sounds natural; 0 sounds choppy).

## Filler / disfluency removal

Transcript words are word-level, so "um", "uh", "like", "you know" are
cuttable the same way — either:

1. Hand-edit `cuts.json`: split the segment containing the filler so the
   word is excluded (`srcEnd` at filler start − 0.03, next `srcStart` at
   filler end + 0.03, re-derive `compStart`s so they stay contiguous), then
   `editnce scaffold --cuts cuts.json` regenerates.
2. Or write the index.html segments yourself using the same
   `data-media-start` pattern.

## Content-driven cuts ("keep only the part where I say X")

Search `transcript.json` for the phrase → get its source time → choose
segment boundaries around it. If the user wants ONE clip, your plan has a
single segment: `{srcStart: word.start-0.2, srcEnd: word.end+0.2, compStart:0}`.

## Cut quality rules

- Cut at WORD boundaries, never mid-word (transcript gives exact word ends).
- Leave 30–80ms after the last phoneme before a cut — pad handles this.
- Don't cut breaths the performance needs: laughter, reactions, sighs often
  sit in "silence" — raise `--threshold` for emotional/beat-driven content.
- When adjacent runs nearly touch (<0.15s gap), merging them often sounds
  better than a micro-cut.
