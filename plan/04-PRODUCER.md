# 04 — Producer (`@framecraft/producer`)

High-level pipeline: project folder → finished file. Used by CLI, studio-server,
render-worker, and the SDK. Also runs as an HTTP render server.

## 1. API

```ts
interface RenderOptions {
  entry?: string;                 // default from framecraft.json or "index.html"
  composition?: string;           // render a sub-composition standalone (path)
  output: string;                 // file or directory (png-sequence / hls)
  fps?: number | { num: number; den: number };
  quality?: "draft" | "standard" | "high";
  format?: "mp4" | "mov" | "webm" | "gif" | "png-sequence" | "hls";
  codec?: "h264" | "h265";
  crf?: number; bitrate?: string;
  resolution?: "landscape" | "portrait" | "square" | "landscape-4k" | "portrait-4k" | "square-4k";
  range?: { from?: number; to?: number };   // seconds
  workers?: number | "auto";
  captureMode?: "auto" | "beginframe" | "screenshot";
  gpu?: boolean;                  // hardware encoder
  browserGpu?: boolean;           // hardware GL in chrome
  videoFrameFormat?: "auto" | "jpg" | "png";
  normalizeAudio?: boolean;
  variables?: Record<string, unknown>;
  lowMemory?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  logger?: Logger;
}
interface RenderProgress {
  stage: "compile" | "probe" | "extract" | "capture" | "encode" | "audio" | "mux" | "done";
  framesDone: number; framesTotal: number; percent: number; etaSeconds: number | null;
  message?: string;
}
interface RenderResult {
  output: string; durationSeconds: number; frames: number; fps: Fps;
  width: number; height: number; sizeBytes: number; timings: Record<string, number>;
  warnings: Diagnostic[];
}
render(projectDir: string, opts: RenderOptions): Promise<RenderResult>
```

Overall percent weights: compile 2%, probe 2%, extract 10%, capture+encode 80%, audio 4%, mux 2%.

## 2. Pipeline stages

```
1 resolve      → read framecraft.json, entry, composition target, apply CLI overrides
2 preflight    → ffmpeg present (≥6), chrome ensured, disk space ≥ 2× estimated output + frame cache
3 lint gate    → run static lint; errors abort (unless --no-lint); warnings attached to result
4 compile      → build a self-contained render bundle in a temp dir (§3)
5 probe        → ffprobe every media file (parallel, cached by path+mtime+size)
6 timing       → compileTiming with probe results; final duration, frame count, range → frame range
7 extract      → video frames (engine §4)
8 capture      → single or parallel capture with streaming/chunk encoder (engine §3, §6, §8)
9 audio        → mixAudio (engine §7) — runs concurrently with capture (independent)
10 mux         → final container; for png-sequence copy audio sidecar; for hls package
11 verify      → ffprobe output: duration within 1 frame, stream count, resolution; else E_OUTPUT_INVALID
12 cleanup     → remove temp dir (keep on --keep-temp or failure with --debug)
```

## 3. Compile (`compile/`)

Input: project dir. Output: `tmp/render-<id>/` containing `index.html` + copied/linked
assets, served by the engine file server.

3.1 **Load** the entry HTML; resolve sub-composition files (keep them as files; the runtime
mounts them — do not inline, so behaviour equals preview).

3.2 **Vendor scripts**: rewrite known CDN URLs (gsap, lottie-web, animejs, three) to local
vendored copies under `/__fc/vendor/` (bundled in producer package, pinned versions). Any
other remote `<script src>`: download once to cache (`~/.cache/framecraft/remote/`) and
rewrite; fail if offline and not cached (`E_REMOTE_ASSET`).

3.3 **Fonts**: find Google Fonts `<link>`/`@import` → fetch CSS with a modern UA → download
each woff2 → write `assets/__fonts/*.woff2` + rewritten `@font-face` CSS; replace link.
Also scan CSS `font-family` usage; warn if a family is used but not loaded (system fallback).
Cache by URL. Desktop/offline: fonts already localized at `add`/`init` time.

3.4 **Remote media**: `http(s)` `src` on img/video/audio → download to cache → rewrite.
`data:` URIs larger than 1 MB → lint error (base64 media prohibited).

3.5 **Video replacement** (render mode only): for each `<video>` replace the element with
`<img data-fc-video-frame data-fc-video-id="{id}">` carrying the same `id`, `class`,
`style`, `data-*` attributes. If the author did not set `object-fit`, set
`object-fit: contain` (the HTML `<video>` default) so the frame image is laid out exactly
like the video was. Copy `width`/`height` attributes. This is a source transform done
before author scripts run, so GSAP selectors targeting `#id` still match.

3.6 **Image prep**: HEIC/HEIF → PNG via sharp; animated GIF → extract frames like a video
(treat as `<video muted>` internally) so it seeks deterministically; SVG untouched.

3.7 **Inject runtime config + runtime** (02-RUNTIME §1) with `mode: "render"`, `probe` map
(durations), `variables`, `seed`.

3.8 **Stage background**: if root lacks a background, inject
`[data-root] { background: var(--fc-stage, #000) }` unless alpha output.

## 4. Render bundle server
The engine file server serves the temp dir plus `/__fc/runtime.js`, `/__fc/vendor/*`,
`/__fc/frames/<videoId>/<n>.jpg`. Bind `127.0.0.1`, random port.

## 5. Range rendering
`range.from/to` → frame range `[ceil(from*fps), floor(to*fps))`; audio mixed for the same
window (shift by `-from`).

## 6. Errors (stable codes)
`E_FFMPEG_MISSING`, `E_FFMPEG_TOO_OLD`, `E_CHROME_LAUNCH`, `E_PAGE_NEVER_READY`,
`E_TIMELINE_NOT_REGISTERED` (warning in render), `E_LINT_FAILED`, `E_MEDIA_PROBE`,
`E_VIDEO_EXTRACT`, `E_CAPTURE_TIMEOUT`, `E_ENCODE_FAILED`, `E_AUDIO_MIX_FAILED`,
`E_OUTPUT_INVALID`, `E_DISK_FULL`, `E_ABORTED`, `E_REMOTE_ASSET`, `E_ASPECT_MISMATCH`.
Each has `hint` text in `errors.ts`.

## 7. HTTP render server (`producer/server`)

`startServer({ port, concurrency, workDir, authToken? })` — Hono:

| Route | Body | Result |
|---|---|---|
| `POST /render` | `{ projectDir? , bundleUrl?, html?, options }` | `{ jobId }` |
| `POST /render/stream` | same | NDJSON stream of progress events then `{type:"done", result}` |
| `GET /jobs/:id` | | job state + progress |
| `DELETE /jobs/:id` | | cancel |
| `GET /jobs/:id/output` | | file download |
| `GET /health` | | `{ ok, version, chrome, ffmpeg, activeJobs }` |

- Bearer token auth if `authToken` set. Concurrency queue (default 1 per 4 CPUs).
- `bundleUrl` = signed URL to a project zip (cloud path); download + verify sha256 + unzip (zip-slip safe).
- Never accept arbitrary filesystem paths when exposed beyond localhost (`projectDir` only allowed when `allowLocalPaths: true`).

## 8. Render history
Every render writes `renders/.history.jsonl` entry: `{ id, startedAt, finishedAt, options, result|error, gitSha? }`.
Studio shows this list.

## 9. Acceptance criteria
- End-to-end fixture matrix: each format × (with/without audio) × (with/without video) produces a valid file (ffprobe check) and correct duration.
- Offline compile works when fonts/remote assets are cached; fails with `E_REMOTE_ASSET` otherwise.
- Range render 2.0–4.0 s of a fixture equals frames 60–119 of the full render.
- Server: concurrent jobs respect concurrency; cancel kills processes within 3 s.
- Standalone sub-composition render (`composition: "compositions/x.html"`) works.
