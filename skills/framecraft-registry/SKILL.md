---
name: framecraft-registry
description: Framecraft registry — ready-made blocks (sub-compositions), components, and the SFX library. Search FIRST before hand-building any named visual: captions, cards, lower-thirds, stats, alerts, CTAs, titles, progress bars, transitions, flashes, grades, zooms, or sound effects. Covers `framecraft catalog`, `framecraft add`, block wiring, variables, and authoring new blocks.
---

# Registry

Blocks are self-contained HTML sub-compositions installed into the project's
`compositions/<name>/` and referenced via `data-composition-src` +
`data-composition-id` on the host element (or inlined).
They ship neutral defaults — every color, font, and size is a `data-var-*`
variable so the user's style.md drives the look, not the block.

## Find

```bash
framecraft catalog                 # everything installed
framecraft catalog --query caption # search
```

Also browse `registry/blocks/` and `registry/sfx/` in the Framecraft repo.

## Install

```bash
framecraft add word-captions        # → compositions/word-captions/
framecraft add sfx/impact           # → assets/sfx/impact.mp3
```

## Blocks (v1 set)

| block | use |
|---|---|
| `word-captions` | one-word kinetic captions from transcript+cuts |
| `phrase-captions` | 2–5 word caption groups |
| `card` | glass info card (title + body) |
| `alert-card` | warning/danger variant of card |
| `stat-card` | one huge number/word + label |
| `cta` | follow/subscribe pill |
| `title-card` | opening title treatment |
| `lower-third` | name/context strip |
| `progress-bar` | thin top/bottom progress line |
| `flash` | 80–120ms full-frame color hit |
| `grade` | full-frame CSS grade/vignette |
| `zoom-transition` | punch-in/out between segments |
| `motion-presets` | named data-fc-motion recipes to copy |
| `subtitle-line` | static lower-third subtitle style |

## Variables

Blocks read `data-var-*` from the host element or `:root` CSS custom
properties. Example wiring:

```html
<div class="clip" data-composition-id="alert-1" data-start="0" data-duration="3"
     data-composition-src="compositions/alert-card/index.html"
     data-var-title="RED FLAG" data-var-accent="#e5484d"></div>
```

Variables are always `data-var-<name>` → inside the block as
`var(--<name>, fallback)`. When a user repeats a look, put the values in
their `style.md`, not in the block source.

## SFX

`registry/sfx/` — synthesized pack (`sfx.json` index + `LICENSES.md`).
`framecraft add sfx/<name>` copies the file + prints the wiring snippet.
All are self-generated: safe to ship in commercial products.

## Authoring a new block

1. `registry/blocks/<name>/index.html` — a composition root with
   `data-composition-id="<name>"` and its own `data-width/height/duration`.
2. `block.json` — `{name, description, tags[], vars[{name, default, hint}]}`.
3. Keep it style-free: defaults must be neutral (white/gray, system fonts);
   anything opinionated becomes a var.
4. Register it in `registry/catalog.json` `{blocks:[{name,path,tags}]}`.
