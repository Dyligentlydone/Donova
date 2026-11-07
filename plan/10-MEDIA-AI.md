# 10 — Media & AI Services (`@framecraft/media`)

All functions are usable from CLI, studio-server (as jobs), and agent tools. Each provider
sits behind an interface so local/free and paid cloud options are interchangeable.

## 1. Media utilities
- `probe(path)` — ffprobe JSON → normalized `MediaProbe { kind, duration, width, height, rotation, fps, hasAudio, audioChannels, sampleRate, codec, pixFmt, hdr, bitrate }`. Cache by path+mtime+size in `~/.cache/framecraft/probe.json`.
- `thumbnail(path, t, width)`, `filmstrip(path, count, height)` (sprite via `tile` filter), `waveformPeaks(path, peaksPerSecond)` (decode `-ac 1 -ar 8000 -f s16le` → min/max buckets).
- `transcodeProxy(path)` — for preview of heavy formats (ProRes, HEVC 10-bit, >4K): ffmpeg → H.264 1080p proxy `assets/.proxies/<hash>.mp4`; Studio preview uses proxy (runtime `proxySrc` mapping), render uses original.
- `normalizeLoudness(in, out, lufs)` two-pass loudnorm.

## 2. Transcription
Provider interface:
```ts
transcribe(input, { model, language?, prompt?, signal, onProgress }): Promise<Transcript>
interface Transcript {
  language: string; duration: number;
  words: { text: string; start: number; end: number; confidence: number; speaker?: string }[];
  segments: { text: string; start: number; end: number; words: [startIdx, endIdx] }[];
}
```
Local provider (default): whisper.cpp.
- `media/whisper/install.ts`: download prebuilt `whisper-cli` per platform (or build from source on Linux via cmake if no binary), and models `ggml-{tiny,base,small,medium,large-v3}.bin` from the official Hugging Face repo (`ggerganov/whisper.cpp`), verify sha256, store in `~/.cache/framecraft/whisper/`.
- Pipeline: ffmpeg → 16 kHz mono WAV → `whisper-cli -m model -f in.wav -oj -ojf -ml 1 -sow -l auto` (full JSON with token timestamps) → merge tokens into words (tokens starting with space begin a new word; strip special tokens) → `transcript.json`. (Flags change between whisper.cpp releases: pin a release, and verify flags against `whisper-cli --help` for that release in a test.)
- Default model `small` (good balance); `base` on low-memory machines.
- Optional cloud providers: OpenAI, Deepgram, AssemblyAI (word timestamps + diarization).
Post-processing: punctuation-based segmenting; filler word tagging (`um, uh, like, you know, so` when standalone — configurable list per language); confidence < 0.4 flagged.

## 3. Captions generator
`generateCaptions(transcript, { style, maxChars: 32, maxLines: 2, maxDuration: 3, minDuration: 0.6, highlight: "word"|"none", case: "as-is"|"upper", position: "bottom"|"center"|"top" })`
1. Group words into caption cards: break on sentence end, on pause > 0.35 s, when chars > maxChars × maxLines, or duration > maxDuration.
2. Line-break inside a card balancing line lengths.
3. Emit a sub-composition `compositions/captions.html` with `data-caption-track="true"`, one element per card (`data-start`, `data-duration`), one `<span>` per word with `data-word-start`; GSAP timeline animates per style (pop-in per card, active-word highlight color/scale at word start).
4. Caption styles live in the registry as blocks of type `caption-style` (e.g. `clean-subtitle`, `bold-pop`, `karaoke-highlight`, `boxed-word`, `minimal-lower`); generator fills the style's template.
Editing: Studio Captions panel edits text/timing per card; regenerates only affected cards.

## 4. Text-to-speech
```ts
tts(text, { provider, voice, speed, out }): Promise<{ path; duration; words?: WordTiming[] }>
```
> **Updated by 17 §12:** default local provider is **Kokoro-82M** (Apache-2.0), with
> `say` as fallback. The list below is kept for the paid/alternative providers.

Providers:
- `local-say` (macOS `say -o out.aiff --data-format=LEF32@48000` → ffmpeg to wav/m4a),
- `edge` (Microsoft Edge read-aloud voices via the `msedge-tts` npm package; returns word boundaries) — free, quality good, terms: check usage restrictions before commercial default,
- `elevenlabs`, `openai` (paid, API key), returning word timings where supported (ElevenLabs `with-timestamps`); otherwise run transcription on the output to get word timings.
Script with SSML-lite markers `[pause 0.5]` mapped per provider.

## 5. Background removal
> **Updated by 17 §11:** run a model bake-off first (U²-Net human-seg baseline, as used
> by HyperFrames, vs MODNet, vs winner + temporal smoothing + guided filter). Exclude
> RMBG (non-commercial) and Robust Video Matting (GPL). Requires alpha-aware frame
> extraction (17 §3.1.2). Original notes below.

- Images: `onnxruntime-node` + a matting model (RMBG-1.4 or BiRefNet-lite ONNX; check model license — RMBG-1.4 is non-commercial; prefer a commercially licensed model such as U²-Net (Apache-2.0) or license BiRefNet weights accordingly). Pre: resize to 1024, normalize; post: upscale mask, guided-filter refine, output PNG with alpha.
- Video: per-frame matting at extract fps with temporal smoothing (EMA on mask), encode WebM VP9 alpha. Long job; show progress; GPU via onnxruntime CoreML/CUDA EP when available.

## 6. Audio analysis
- **Beats** (`beats.json { bpm, beats: number[], downbeats: number[], sections: [{start,end,label,energy}] }`): decode mono 22.05 kHz → STFT (2048/512) → spectral flux onset envelope → tempo via autocorrelation of onset envelope (60–200 BPM, prefer 90–140) → dynamic-programming beat tracking (Ellis 2007) → downbeats by accent strength every 4 beats → sections by novelty on chroma/energy. Implement in TS (`fft.ts`) — no native deps.
- **Silence** — `ffmpeg -af silencedetect=noise=-35dB:d=0.4 -f null -` parse stderr → ranges.
- **Loudness** — `ebur128` filter → integrated LUFS, true peak, LRA.

## 7. Stock & generative media providers
- Stock: Pexels API, Pixabay API (free keys; store attribution in `assets/CREDITS.json`).
- Image generation: OpenAI Images, Google Imagen/Gemini, fal.ai (Flux) — provider interface `generateImage(prompt, {size, style})`.
- Video generation (cloud plan): fal.ai / Replicate hosting Veo/Kling/etc. — `generateVideo(prompt, {duration, aspect, imageRef?})` async job.
- Music: user library (`assets/music/`) + licensed catalog via cloud (e.g. a stock music API partner); generative music provider optional.
- SFX: bundled pack under `registry/sfx/` — synthesized by our own script or CC0 only, never Pixabay-licensed files (see 17 §7.3 for the list, format, and install flow).
All downloads recorded in a media ledger `assets/.ledger.json` `{ file, source, url, license, attribution, sha256, createdAt }`.

## 8. Color grading
`data-color-grade='{"exposure":0.2,"contrast":1.1,"saturation":1.05,"temperature":-5,"tint":0,"lift":[...],"gamma":[...],"gain":[...],"lut":"assets/luts/film.cube","intensity":0.8}'`
- Preview: runtime draws the video/img into a WebGL canvas overlay applying the grade (shader with 3D LUT texture).
- Render: apply in FFmpeg during frame extraction (`eq`, `colorbalance`, `colortemperature`, `lut3d=file.cube`), so captured frames already graded. Images: sharp pipeline or same WebGL path in page.
- Ship 12 looks (`registry/looks/`): film, warm, cool, teal-orange, bleach, mono, vintage, vivid, matte, night, sunset, clean.

## 9. Acceptance criteria
- Transcribe fixture speech (known script) → WER < 10% with `small`; word timings within ±80 ms on 90% of words (fixture with forced-aligned reference).
- Captions generator: no card > maxChars×maxLines; cards never overlap; render passes check.
- Beats: fixture 120 BPM click track → bpm 120 ± 1, beats within ±20 ms.
- Silence: fixture with known gaps detected ±50 ms.
- Background removal image fixture IoU ≥ 0.9 vs reference mask.
- Color grade preview vs render PSNR ≥ 35 dB on fixture.
