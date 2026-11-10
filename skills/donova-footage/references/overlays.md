# Overlays, punch-ins, cards

## Punch-in / zoom between cuts

Two idioms, both seek-safe `data-fc-motion`:

- **Jump cut zoom** — alternate each segment's base scale (1.0, 1.08, 1.0,
  1.12…) so cuts feel intentional. Apply `transform: scale()` on the clip's
  inner wrapper, never the `.clip` itself (which must stay full-frame).
- **Slow push** — `scale: [1.0, 1.12]` over the whole segment for tension;
  `[1.15, 1.0]` (pull-back) for release/hook openings.

Block: `zoom-transition` wraps these; motion preset `punch-in` /
`punch-out` / `push` exist in the `motion-presets` block.

## Cards

Blocks: `card` (generic glass), `alert-card` (warning/danger), `stat-card`
(big number), `cta` (follow/subscribe pill), `title-card` (openers),
`lower-third` (name/context strip), `progress-bar`.

Rules that survive every style:

- Cards hold ~2–4s. Time them to the WORD that earns them ("scam" → alert at
  that word's compStart).
- Everything INSIDE the composition rect. The #1 defect is right-edge
  overflow — after adding a card, snapshot at its active time and LOOK.
- Pop in fast (≤0.25s, `back.out`), hold, pop out or cut out with the beat.
- Never stack: one overlay idea per moment. If a card and a big caption would
  collide, lower the caption or move the card — decide via snapshot.
- `flash` (white/color frame ~80–120ms) + a thud/whoosh SFX sells impact
  moments; use sparingly (hooks, the single biggest beat).

## Layering

```
clips (video) → grade/vignette overlay → cards → captions (topmost)
```

Later DOM = on top; keep captions last so nothing covers them.

## Faces

When reframing to vertical, the face is the subject: after scaffold, snapshot
t≈first second and check the face isn't cut or pushed off — shift the
`.clip video` `left` until framed right, and keep captions/cards out of the
face zone.
