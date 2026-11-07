# Look: grade, reframing, backgrounds

## Grade overlays

The compositor honors ordinary CSS. A full-frame `.clip` div acts as a grade:

```html
<div class="clip" data-start="0" data-duration="42"
  style="background: rgba(8,10,16,0.18); mix-blend-mode: multiply;
         pointer-events: none;"></div>
```

- Darken/mood: `multiply` overlay, or `filter: brightness() contrast()
  saturate()` on `.clip video` itself.
- Vignette: `background: radial-gradient(ellipse at center, transparent 55%,
  rgba(0,0,0,0.55) 100%)` full-frame, `pointer-events:none`.
- Warm/cool tint: `filter: sepia()/hue-rotate()` on the video or a translucent
  color overlay with `mix-blend-mode: overlay`.
- Everything here is style territory: if `style.md` names a grade, use ITS
  values; otherwise keep it subtle.

## Reframing (16:9 → 9:16, square, etc.)

`scaffold --width --height` cover-crops: the source scales to fill and the
overflow hides under `.clip`. The default is CENTERED — fine when the subject
is centered. When not:

- The generated CSS positions `.clip video` with explicit `left/top` in px —
  shift `left` until the face/subject sits in frame (snapshot to verify).
- Per-segment offsets are legal when the subject moves (edit the video tag's
  inline style per segment).
- Talking heads: eyes on the upper third line; captions sit below them.

## Backgrounds behind footage

- `data-background="#0b0e14"` on the root element sets the canvas color under
  everything (letterbox bars when aspect doesn't fill).
- Blurred-fill background (bar-free reframe): a second full-window copy of the
  same video, scaled to fill, `filter: blur(40px) brightness(0.6)`, main video
  above it at fit-width.

## Transitions between segments

- Hard cut is the default and usually right for talking heads.
- 4–8 frame cross-dip (opacity fade) for mood changes; `flash` block for
  white/color hits on beats; `zoom-transition` block for punch cuts.
