# 03 — Render Engine (`@editnce/engine`)

Low-level, framework-agnostic: "seekable web page → frames → encoded video", plus audio
mixing. Knows nothing about projects or the contract beyond the `window.__fc` seek protocol.

## 1. Modules

| File | Responsibility |
|---|---|
| `chrome/version.ts` | Pinned Chrome-for-Testing build id for `chrome-headless-shell` |
| `chrome/install.ts` | `ensureBrowser()` via `@puppeteer/browsers` into `~/.cache/editnce/chrome/`; env override `EDITNCE_CHROME_PATH` |
| `chrome/launch.ts` | Launch flags per capture mode; probe beginFrame support |
| `chrome/pool.ts` | Browser lease pool (reuse browsers across renders; max per host) |
| `fileServer.ts` | Hono static server for a directory with runtime injection, Range support |
| `capture/session.ts` | Create page, viewport, navigate, wait ready |
| `capture/beginFrame.ts` | Deterministic capture via `HeadlessExperimental.beginFrame` |
| `capture/screenshot.ts` | Fallback capture via `Page.captureScreenshot` |
| `capture/alpha.ts` | Transparent background capture |
| `video/probe.ts` | ffprobe wrapper (JSON) |
| `video/extract.ts` | Pre-extract video frames with FFmpeg + cache |
| `video/inject.ts` | Feed frames into the page per capture |
| `encode/streaming.ts` | Pipe frames into a long-running FFmpeg |
| `encode/chunk.ts` | Encode a frame range into a closed-GOP chunk; concat chunks |
| `encode/presets.ts` | Quality/format → FFmpeg args |
| `encode/hwaccel.ts` | Detect VideoToolbox / NVENC / QSV / VAAPI |
| `audio/mixer.ts` | Build FFmpeg filter graph, render mixed audio |
| `audio/fx.ts` | Audio effect → FFmpeg filter mapping |
| `audio/loudness.ts` | EBU R128 measure + normalize |
| `parallel/coordinator.ts` | Split frames across workers, collect, order |
| `ffmpeg/locate.ts` | Find ffmpeg/ffprobe (env `EDITNCE_FFMPEG_PATH`, PATH, bundled) + version check |
| `ffmpeg/run.ts` | Spawn with progress parsing (`-progress pipe:2`), abort signal, stderr tail on error |

## 2. Chrome launch

Always use `chrome-headless-shell` (not full Chrome) at the pinned version.

Common flags:
```
--no-first-run --no-default-browser-check   (no --headless flag: headless-shell is always headless)
--hide-scrollbars --mute-audio --disable-background-timer-throttling
--disable-renderer-backgrounding --disable-backgrounding-occluded-windows
--force-color-profile=srgb --font-render-hinting=none --disable-features=Translate,MediaRouter
--disable-dev-shm-usage (Linux containers) --no-sandbox only when EDITNCE_NO_SANDBOX=1 (Docker)
--autoplay-policy=no-user-gesture-required
--allow-file-access-from-files=false (we serve over http)
```

**beginFrame mode (Linux default)** adds:
```
--deterministic-mode --enable-begin-frame-control --run-all-compositor-stages-before-draw
--disable-new-content-rendering-timeout --disable-threaded-animation
--disable-threaded-scrolling --disable-checker-imaging --disable-image-animation-resync
```

**screenshot mode (macOS/Windows default, and fallback)**: none of the beginFrame flags
(`--enable-begin-frame-control` makes a page never paint unless beginFrame is sent).

Mode selection:
1. `--capture-mode beginframe|screenshot|auto` (default auto).
2. auto: Linux → try beginFrame; run `probeBeginFrame()` (enable domain, warm-up frame,
   one screenshot frame, must return non-empty PNG within 5 s). On failure → relaunch in
   screenshot mode and log a warning.
3. macOS/Windows → screenshot.
4. Alpha output on Linux → screenshot (beginFrame compositor loses alpha).

GPU: default `--use-gl=angle --use-angle=swiftshader` in containers (software, deterministic);
locally allow hardware GPU (`--browser-gpu` flag) for WebGL-heavy comps.

## 3. Capture session

```ts
interface CaptureSessionOptions {
  url: string; width: number; height: number;
  deviceScaleFactor?: number;      // supersampling for 4K from 1080 comps
  fps: Fps; mode: "beginframe" | "screenshot";
  format: "jpeg" | "png"; jpegQuality?: number;  // jpeg 92 default for mp4; png for alpha/ProRes
  alpha?: boolean;
  readyTimeoutMs?: number;         // default 45000
  protocolTimeoutMs?: number;      // default 300000
  beforeCapture?: (frame: number, page: Page) => Promise<void>; // video injection hook
}
```

`initializeSession`:
1. `page = await browser.newPage()`; `page.setViewport({ width, height, deviceScaleFactor })`.
2. Forward console/pageerror to logger with `[page]` prefix; count errors.
3. Block requests not to the file server origin (`page.setRequestInterception`) → abort and record.
4. `goto(url, { waitUntil: "load" })`, then `waitForFunction(() => window.__fc?.renderReady === true, { timeout: readyTimeoutMs })`.
   Timeout → `E_PAGE_NEVER_READY` with `__fc.diagnostics()` dumped.
5. beginFrame mode: `HeadlessExperimental.enable`; warm-up: send 10 beginFrames without
   screenshot at `ticks = 1000 + k*interval`; set `baseTicks = lastTick + 10*interval`.
6. Read `window.__fc.duration` to validate frame count.

`captureFrame(session, i)`:
```
t = i * den / num
await page.evaluate(t => window.__fc.renderSeek(t), t)
await opts.beforeCapture?.(i, page)
beginFrame:  res = cdp.send("HeadlessExperimental.beginFrame", {
                 frameTimeTicks: baseTicks + i*interval, interval,
                 screenshot: { format, quality, optimizeForSpeed: true } })
             if error "Another frame is pending" → retry with backoff 50ms·2^k up to 5
             buffer = res.screenshotData ? base64decode : lastBuffer (no damage = identical frame)
screenshot:  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
             res = cdp.send("Page.captureScreenshot", { format, quality, optimizeForSpeed: true,
                   clip: {x:0,y:0,width,height,scale:1}, captureBeyondViewport: false, fromSurface: true })
return buffer
```
Note: in screenshot mode the runtime's rAF shim must be disabled for the double-rAF wait
(runtime exposes `__fc._realRaf`); use it.

Damage optimization (beginFrame): send a screenshot-less beginFrame first; if
`hasDamage === false` reuse the previous buffer. Off by default until golden tests pass with it on.

Alpha: `Emulation.setDefaultBackgroundColorOverride({ color: {r:0,g:0,b:0,a:0} })`, inject
CSS `html,body,[data-composition-id]{background:transparent!important}`, PNG format.

## 4. Video frame extraction

Input: list of `<video>` clips from the compiled model with `src, mediaStart, duration,
playbackRate, automation.rate`, and the output fps.

For each video:
1. Probe: duration, width, height, rotation (side data), avg_frame_rate, pix_fmt, color
   transfer (HDR detect: `smpte2084`/`arib-std-b67`), has audio.
2. Needed window in source time: `[mediaStart, mediaStart + duration*rate]` (or integral
   of rate lane). Extract fps = `outputFps * maxRate` (so fast playback has frames).
3. Command (JPEG default; PNG for `--video-frame-format png` or alpha sources):
   ```
   ffmpeg -hide_banner -ss {winStart} -i {src} -t {winLen}
          -vf "fps={extractFps}:start_time=0:round=up,scale={targetW}:{targetH}:flags=lanczos[,format=rgba]"
          -q:v 2 (jpeg) | -compression_level 1 (png)
          {cacheDir}/%06d.jpg
   ```
   `targetW/H` = displayed box size × deviceScaleFactor (measured from the compiled page at
   max size the element reaches; fall back to source size capped at composition size × 2).
   Apply rotation automatically (ffmpeg autorotates by default; keep it).
4. Cache: key = sha256(src absolute path + mtime + size + window + extractFps + target size + format).
   Dir `~/.cache/editnce/frames/<key>/` with `done.json` marker written last. LRU prune to
   `EDITNCE_FRAME_CACHE_GB` (default 10).
5. Mapping time → file: `index = floor((mediaTime - winStart) * extractFps + 1e-6)`, clamp
   to `[0, count-1]` (hold last frame at tail).
6. HDR sources: tone-map to SDR with `zscale=t=linear,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709`
   unless rendering HDR output (out of scope for v1; keep an `hdr` flag stubbed).
7. Parallelize extraction across videos (concurrency = min(4, cpus/2)).

## 5. Frame injection

Reference path: the runtime sets `img.src = /__fc/frames/<id>/<index>.jpg` (served by file
server from the cache dir) and awaits decode. Fast path (optional, behind flag
`--inject cdp`): before capture, `page.evaluate` sets `img.src` to a data URI from an LRU
cache (entry and byte bounded: 256 entries / 512 MB). Measure; keep whichever is faster
per platform as default.

## 6. Encoding

### 6.1 Presets (`encode/presets.ts`)

| Quality | x264 preset | CRF | Notes |
|---|---|---|---|
| draft | ultrafast | 28 | previews |
| standard | medium | 18 | default |
| high | slow | 14 | |

MP4/H.264: `-c:v libx264 -preset P -crf Q -pix_fmt yuv420p -profile:v high -movflags +faststart -r FPS -colorspace bt709 -color_primaries bt709 -color_trc bt709`
H.265: `-c:v libx265 -tag:v hvc1` (Apple compatibility).
HW: macOS `h264_videotoolbox -b:v {bitrate} -allow_sw 1`; NVIDIA `h264_nvenc -preset p5 -cq Q`;
Intel `h264_qsv`. Bitrate for HW = `width*height*fps*0.1` bits/s (standard), ×0.5 draft, ×1.6 high.
WebM alpha: `-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -auto-alt-ref 0 -row-mt 1 -cpu-used 4 -metadata:s:v:0 alpha_mode=1`.
MOV alpha: `-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -vendor apl0`.
GIF: two-pass palette: `palettegen=stats_mode=diff` then `paletteuse=dither=sierra2_4a`, fps ≤ 30, width ≤ 1080.
PNG sequence: write `frame_%06d.png`, sidecar `audio.m4a`.
HLS: `-c:v libx264 ... -f hls -hls_time {seg} -hls_playlist_type vod -hls_segment_filename video_%05d.ts video.m3u8`, separate audio rendition, `master.m3u8`; force keyframes at segment boundaries `-force_key_frames "expr:gte(t,n_forced*{seg})"`.

### 6.2 Streaming encoder (default, single worker)
```
ffmpeg -y -hide_banner -f image2pipe -framerate {fps} -c:v mjpeg|png -i pipe:0 {codec args} {out.video.mp4}
```
Write each captured buffer to stdin; respect backpressure (`stdin.write` returns false → await `drain`).
On abort: `stdin.destroy()`, kill SIGKILL after 2 s, delete partial output.

### 6.3 Chunk encoder (parallel)
Each worker encodes its contiguous range `[a, b)` into `chunk_{k}.mp4` with closed GOP:
`-g {2*fps} -keyint_min {2*fps} -sc_threshold 0 -x264-params open-gop=0 -force_key_frames 0`.
Concat: write `list.txt` (`file 'chunk_000.mp4'`…) → `ffmpeg -f concat -safe 0 -i list.txt -c copy video.mp4`.
Verify total frame count with ffprobe `-count_packets`.

## 7. Audio mixer

### 7.1 Input model
```ts
interface AudioTrack {
  id: string; src: string;            // file path (video files allowed; use their audio stream)
  absStart: number; duration: number; // timeline placement (s)
  mediaStart: number; rate: number;   // or rateLane
  volume: number; fadeIn: number; fadeOut: number;
  volumeLane?: Keyframe[]; rateLane?: Keyframe[];
  fx?: FxNode[]; group?: string;      // <ec-audio-group> membership
}
```
Sources: every `<audio>`; every `<video>` with `data-has-audio="true"` and not `muted`.

### 7.2 Filter graph per track `i`
```
[i:a] atrim=start={ms}:end={ms+dur*rate}, asetpts=PTS-STARTPTS,
      {atempo chain for rate: split into factors within [0.5, 2.0]},
      aresample=48000, aformat=channel_layouts=stereo,
      volume={static or expr with eval=frame for lanes},
      afade=t=in:st=0:d={fadeIn}, afade=t=out:st={dur-fadeOut}:d={fadeOut},
      {fx filters},
      adelay={startMs}|{startMs}
  [a{i}]
```
Mix: `[a0][a1]... amix=inputs=N:duration=longest:dropout_transition=0:normalize=0, apad, atrim=0:{total} [mix]`
(`normalize=0` requires FFmpeg ≥ 4.4; for older builds compensate with `volume=N`).
Master: optional `[mix] {master fx}, alimiter=limit=0.95 [out]`.
Output: `-c:a aac -b:a 192k -ar 48000 audio.m4a`.
If graph string > 32 KB, write it to a file and pass `-/filter_complex file` (FFmpeg ≥ 7)
or `-filter_complex_script file` (older).

Volume lanes → expression: piecewise linear `if(between(t,t0,t1), v0+(v1-v0)*(t-t0)/(t1-t0), ...)`
with `eval=frame`; simplify constant lanes to a static volume.

### 7.3 Groups & ducking
`<ec-audio-group id="music-bus" data-fx-chain="[...]" data-volume="0.8">` contains member
`<audio>` elements (by `data-group="music-bus"`). Members are mixed into a submix, then the
group's fx/volume applies. Ducking ("voiceover carve"): `sidechaincompress` with the voice
group as sidechain: `[music][voice_sc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300`.

### 7.4 Loudness
`--normalize` (default on for social presets): two-pass `loudnorm=I=-14:TP=-1:LRA=11`
(measure pass prints JSON; second pass uses `measured_*` values with `linear=true`).

### 7.5 FX mapping

| fx id | FFmpeg filter |
|---|---|
| gain | `volume={dB}dB` |
| peaking | `equalizer=f={f}:t=q:w={q}:g={g}` |
| lowshelf / highshelf | `lowshelf=f=..:g=..` / `highshelf=...` |
| highpass / lowpass | `highpass=f=..:p={poles}` / `lowpass=...` |
| compressor | `acompressor=threshold={dB→lin}:ratio=..:attack=..:release=..:knee=..:makeup=..:mix=..` |
| limiter | `alimiter=limit=..:attack=..:release=..` |
| gate | `agate=threshold=..:ratio=..` |
| delay | `aecho=1:{mix}:{ms}:{feedback}` |
| reverb | `aecho` multi-tap preset (v1) ; convolution `afir` with bundled IR (v2) |
| deesser | `deesser` |
| denoise | `afftdn=nf=-25` |

Preview (runtime Web Audio) must implement the same set with matching parameters.

### 7.6 Mux
```
ffmpeg -i video.mp4 -i audio.m4a -map 0:v:0 -map 1:a:0 -c:v copy -c:a copy -shortest -movflags +faststart out.mp4
```
If no audio tracks: copy video only (no silent track unless `--silent-audio` for platforms that require it).

## 8. Parallel coordinator

- Worker count auto: `min(floor(cpus/2), floor(freeMemGB / 1.5), 8, ceil(frames/60))`, min 1.
  Low-memory mode (total RAM ≤ 8 GB or `--low-memory`): 1 worker, screenshot mode, JPEG.
- Each worker: own browser page (shared browser process OK up to 4 pages; beyond that
  separate browser processes), own capture session, own chunk encoder.
- Contiguous ranges (better cache locality and per-chunk GOP); sizes balanced by a cost
  hint (frames where many videos are active cost more — estimate from clip manifest).
- Progress: aggregate frames done / total; ETA from moving average of last 60 frames.
- Failure: if a worker crashes, retry its remaining range once on a fresh browser; second
  failure fails the job with the worker's last 50 log lines.
- Distributed (cloud): the same range split is performed across machines (12-CLOUD §4).

## 9. Public API

```ts
ensureBrowser(opts?): Promise<string>                      // path to headless shell
locateFfmpeg(): Promise<{ ffmpeg: string; ffprobe: string; version: string }>
probeMedia(path): Promise<MediaProbe>
extractVideoFrames(videos, opts): Promise<ExtractedFrames[]>
createCaptureSession(opts): Promise<CaptureSession>
captureFrame(session, frameIndex): Promise<Buffer>
closeCaptureSession(session)
createStreamingEncoder(opts): Encoder  // write(buf), finish(), abort()
encodeChunk(opts), concatChunks(paths, out)
mixAudio(tracks, opts): Promise<{ path: string | null }>
mux(video, audio, out, opts)
runParallelCapture(plan, opts): Promise<ChunkResult[]>
```

## 10. Acceptance criteria
- `ensureBrowser` downloads pinned headless shell once; second call is instant.
- beginFrame determinism: on Linux Docker, rendering fixture `fixtures/engine/gsap-basic` twice gives identical MP4 sha256 (encode with `-threads 1` + `-x264-params deterministic=1` in the determinism test).
- Screenshot mode on macOS produces PSNR ≥ 45 dB vs Linux beginFrame golden frames.
- Video extraction: a 29.97 fps source placed at `data-start=2 data-media-start=5` shows the correct source frame at 10 sampled timestamps (fixture with burned-in timecode; OCR-free check: frames carry encoded colour barcode).
- Audio: a 1 kHz beep at known source offset lands within ±1 ms (48 samples) of the expected output time; fades and volume match expected RMS ±0.5 dB.
- Parallel: 4-worker render of a 20 s fixture is frame-identical to single-worker output (compare decoded frames by hash).
- Abort mid-render cleans temp files and kills all child processes (no orphan chrome/ffmpeg).
