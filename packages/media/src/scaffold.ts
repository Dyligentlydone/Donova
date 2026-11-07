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
  sourceWidth: number;
  sourceHeight: number;
  outWidth: number;
  outHeight: number;
  plan: CutPlan;
  fps?: number;
  /** Keep source audio on the video elements (default true). */
  audio?: boolean;
}): string {
  const { source, sourceWidth, sourceHeight, outWidth, outHeight, plan, fps = 30, audio = true } = opts;

  // Cover-crop math: scale source to fill output, overflow hidden by .clip.
  const scale = Math.max(outWidth / sourceWidth, outHeight / sourceHeight);
  const dispW = Math.round(sourceWidth * scale * 100) / 100;
  const dispH = Math.round(sourceHeight * scale * 100) / 100;
  const offX = Math.round((outWidth - dispW) / 2);
  const offY = Math.round((outHeight - dispH) / 2);

  const duration = Math.round(plan.duration * 1000) / 1000;
  const segs = plan.segments
    .map(
      (
        s,
      ) => `  <div class="clip" data-start="${s.compStart.toFixed(3)}" data-duration="${s.duration.toFixed(3)}">
    <video src="${escapeHtml(source)}"${audio ? "" : " muted"} data-media-start="${s.srcStart.toFixed(3)}"${audio ? "" : ' data-has-audio="false"'}></video>
  </div>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>framecraft composition</title>
<style>
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; }
  .clip { position: absolute; inset: 0; overflow: hidden; }
  .clip video {
    position: absolute;
    width: ${dispW}px; height: ${dispH}px;
    left: ${offX}px; top: ${offY}px;
    object-fit: fill;
  }
</style>
</head>
<body>
<div data-composition-id="main" data-width="${outWidth}" data-height="${outHeight}" data-duration="${duration}" data-fps="${fps}">
${segs}
</div>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
