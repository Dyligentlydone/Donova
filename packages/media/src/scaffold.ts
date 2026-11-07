import type { CutPlan } from "./types.js";

/**
 * Footage → neutral composition HTML (17 §3.4).
 *
 * Emits one timed clip per kept segment with the SAME src + data-media-start
 * (exercises the multi-segment mediaIndex path). Zero style decisions:
 * no captions, no cards, no grade — those are blocks the agent adds after.
 * Cover-crop centers the source in the output frame.
 */
export function scaffoldFootage(opts: {
  source: string;
  outWidth: number;
  outHeight: number;
  plan: CutPlan;
  fps?: number;
  /** Keep source audio on the video elements (default true). */
  audio?: boolean;
}): string {
  const { source, outWidth, outHeight, plan, fps = 30, audio = true } = opts;

  // object-fit:cover handles the cover-crop for any source dims/rotation —
  // the browser already applies display-matrix rotation to <video>.

  const duration = Math.round(plan.duration * 1000) / 1000;
  // HyperFrames media model: a media clip is the timed element itself —
  // <video class="clip" data-start data-duration data-media-start>.
  const segs = plan.segments
    .map(
      (s, i) =>
        `  <video id="vid-${i}" class="clip" src="${escapeHtml(source)}" data-start="${s.compStart.toFixed(3)}" data-duration="${s.duration.toFixed(3)}" data-media-start="${s.srcStart.toFixed(3)}"${audio ? ' data-has-audio="true"' : ' muted data-has-audio="false"'}></video>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>framecraft composition</title>
<script>window.__timelines = window.__timelines || {};</script>
<style>
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; }
  .clip { position: absolute; inset: 0; overflow: hidden; }
  video.clip, audio.clip {
    position: absolute;
    inset: 0; width: 100%; height: 100%;
    object-fit: cover;
  }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-width="${outWidth}" data-height="${outHeight}" data-duration="${duration}" data-fps="${fps}" data-no-timeline>
${segs}
</div>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
