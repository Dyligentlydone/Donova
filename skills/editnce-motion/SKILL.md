---
name: editnce-motion
description: Editnce animation — data-fc-motion attribute reference (keyframes, easing, split/stagger), the two animation paths (attribute vs GSAP code), seek-safety rules, named motion presets, and when to use which. Use for any animation, transition, punch-in, text effect, or GSAP timeline work in an Editnce composition.
---

# Motion

Two animation paths — never mix them on the same element:

1. **`data-fc-motion`** — declarative, JSON-in-attribute. Seek-safe, Studio-
   editable, preferred for everything the agent writes.
2. **GSAP** — `window.__timelines["comp-id"] = gsap.timeline({paused:true})`.
   For code-authored, complex choreography. The runtime seeks `totalTime(t)`.

## data-fc-motion

```html
<div class="clip" data-start="0" data-duration="3"
  data-fc-motion='{
    "v": 1,
    "split": "words",            // chars|words|lines|none
    "stagger": 0.08,             // per-split delay
    "anims": [
      { "t": 0, "dur": 0.8, "ease": "power3.out",
        "props": { "opacity": [0, 1], "translateY": ["0.6em", "0em"] } },
      { "t": 2.4, "dur": 0.4, "ease": "power2.in",
        "props": { "opacity": [1, 0] } }
    ]
  }'>
```

- `t` is seconds inside the ELEMENT's local timeline.
- `props` values are `[from, to]` (or `[a,b,c…]` keyframes) of CSS-ish props:
  `opacity, scale, scaleX, scaleY, translateX, translateY, translateZ, rotate,
  rotateX, rotateY, skewX, skewY, blur (filter), brightness, letterSpacing,
  width, height, top, left, right, bottom, color, backgroundColor`.
- Units: numbers default px for translate/size; strings like `"0.6em"` ok.
- Eases (GSAP names): `linear, power1-4.in/out/inOut, back.in/out/inOut(k),
  elastic.out/inOut, bounce.out, expo.in/out, circ, sine, steps(n)`.

## Presets (from the motion-presets block — copy freely)

- `punch-in`: scale 0.6→1, opacity 0→1, 0.18s, `back.out(2)`.
- `punch-out`: scale 1→1.15 + opacity→0, 0.2s, `power2.in`.
- `pop`: scale 0.9→1.03→1, 0.3s.
- `push`: scale 1→1.12 over duration, `linear`.
- `pull-back`: scale 1.15→1, `power2.out`.
- `shake`: translateX ±8px steps, 0.4s (danger/error beats).
- `fade-up`: opacity + translateY 24px→0, `power3.out`.
- `flash-in`: opacity 0→1 in 0.06s (with the `flash` block).

## Seek safety — the contract's spine

- Everything must be a pure function of composition time `t`. Rendering seeks
  to arbitrary frames forward AND backward — `renderSeek(t)` must produce
  identical output regardless of direction or history.
- FORBIDDEN in compositions: `Date.now()`, `new Date()`, `Math.random()`
  (unseeded), `setInterval`, rAF-driven animation, `fetch()` at runtime,
  CSS `animation` that isn't driven by the runtime adapter.
- For randomness use a seeded PRNG (mulberry32) inside a `<script>` that
  builds deterministic keyframes.

## GSAP path

```html
<script src="gsap.min.js"></script>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.to("#box", { x: 300, duration: 1 }, 0)
    .to("#box", { opacity: 0, duration: 0.5 }, 1);
  window.__timelines["main"] = tl;
</script>
```

- ONE paused root timeline per composition id. Scene sub-timelines added to
  it must NOT be paused (paused children don't advance under root seek).
- Studio's visual tools never touch GSAP — code-authored timelines are
  read-only to the editor; new motion goes through `data-fc-motion`.
