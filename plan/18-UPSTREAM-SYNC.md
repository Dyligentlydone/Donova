# 18 — Upstream Sync Backlog (HyperFrames → Framecraft)

We pin `hyperframes` as a dependency for the Studio bundle + delegate commands, so
engine fixes ship to us for free on each bump. What does NOT come free: features
that live in *their* engine/runtime — our `packages/engine` + `producer` are ours.
This file tracks items worth porting, reviewed per release. Last sync: 0.9.20 →
0.9.22 (weekly digests through Oct 26, 2026 reviewed).

## Port into our producer/engine (priority order)

1. **Video-layer passthrough** — `HF_VIDEO_LAYER_PASSTHROUGH`: when the video fills
   the canvas, ffmpeg composites it under the page instead of capturing every
   frame. Our core use case is footage-first edits — this is likely a 5-10× render
   speedup on video+text comps like flower-catch. Biggest single win available.
   Implement in producer: detect comps where one video covers the whole frame and
   no overlays/captions intersect → skip capture, composite directly.
2. **Motion blur** — `data-motion-blur="on"` + Studio's Blur tab (which we serve!)
   writes it. Our runtime ignores the attribute → preview/render divergence.
   Either implement (240° shutter ≈ 32 samples, filter tier for pure translates,
   capture tier for scale/rotate) or strip the Blur tab in the rebrand patcher
   until we do.
3. **Speed wins**:
   - x264 `fast` preset for high-quality MP4 output
   - encode-while-capture (start ffmpeg when frames begin, not after)
   - worker sizing from container CPU quota (read cgroup limits — matters for
     Cloud Run jobs where vCPU is capped)
   - VideoToolbox hwaccel on macOS for frame extraction
   - audio mix runs while capture browsers launch
   - remote video downloads once per render, not twice
4. **Partial verification for agent loops**: `check --range`/`--components`,
   `snapshot --range`/`--composition`/`--keep` (our check/snapshot are native —
   port flags, can't delegate).
5. **Delivery encode flags**: `--keyframe-interval`, `--max-bitrate`,
   `--buffer-size` passthrough; `--prores-profile` (4444/hq/422/lt/proxy);
   `render --start/--end` span export.
6. **Audio quality**: peak-by-peak limiter instead of lowering the whole mix when
   the ceiling is passed; message when a global lower was applied; HDR→SDR
   tone-map for SDR-only formats; HEIC→JPEG at compile time.

## Copy for plan/12 (cloud)

- **SSRF guard**: refuse downloads from hosts resolving to private addresses —
  needed anywhere the cloud fetches remote media URLs (their fix: 9830059bd).
- **Device grant login** (`auth login --device`, RFC 8628): their production shape
  confirms plan/12's design — required for headless machines (Mac mini, SSH).
- **Bundle hygiene**: `.hyperframesignore`-style file, drop root renders/snapshots
  from uploads, `--dry-run` on upload size — keeps bundles under limits.
- **Plan v2 manifest-last publisher**: writes plan artifacts straight to S3/GCS —
  reference implementation for our render-job artifact flow (already reachable
  via `fc cloudrun` delegate for our own use).

## Studio freebies already in the served bundle (0.9.22)

GIF export w/ loop count, Blur tab, keyframe ease editor, grade curves/wheels
inspector, flat inspector default, external-file-edit conflict UI (big for
agent+human co-editing), preview proxies + quality picker, timeline perf for
thousands of clips, 2GiB+ export downloads, preview scene culling / seek-bar.

## Structural drift to revisit

- Published skills consolidated 21 → 7 (domain skills folded into guides inside
  `hyperframes`/`media-use`). Our ported set mirrors the old structure — fine for
  now, re-sync when we publish our own skill catalog.
- Docs moved: hyperframes.dev → hyperframes.studio.
- `auth`, `billing`, `cloud`, `publish`, `open`, `catch-up`, `templates`,
  `reverse`, `feedback`, `telemetry`, `upgrade` — HeyGen-backend surfaces we
  intentionally skip; our own equivalents land with plan/12 + desktop app.
