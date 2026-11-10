import { resolve } from "node:path";
import { startFileServer } from "@donova/engine";

/**
 * `donova preview` — serve the project + a minimal seek-scrub UI.
 * The full Studio editor is a separate app; this is the fast local check.
 */
export async function previewProject(
  projectDir: string,
  composition = "index.html",
): Promise<{ url: string; close: () => Promise<void> }> {
  const dir = resolve(projectDir);
  const inner = await startFileServer(dir);

  // Tiny scrubber page served by a second server that iframes the composition.
  const { createServer } = await import("node:http");
  const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111;color:#eee;font:13px system-ui;display:flex;flex-direction:column;height:100vh">
<div style="flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden">
  <div id="stage" style="position:relative;transform-origin:top left">
    <iframe id="f" src="${inner.url}/${composition}" style="border:0;display:block"></iframe>
  </div>
</div>
<div style="padding:8px;background:#1a1f26;display:flex;gap:10px;align-items:center">
  <button id="play">▶</button>
  <input id="scrub" type="range" min="0" max="1000" value="0" style="flex:1">
  <span id="t">0.00s</span>
</div>
<script>
const f = document.getElementById('f'), scrub = document.getElementById('scrub'), tEl = document.getElementById('t');
let dur = 1, playing = false, raf = 0, t = 0;
const seek = async (tt) => { t = tt; await f.contentWindow.__fc?.renderSeek(tt); tEl.textContent = tt.toFixed(2)+'s'; };
f.onload = async () => {
  await new Promise(r => { const i = setInterval(() => { if (f.contentWindow.__playerReady) { clearInterval(i); r(); } }, 50); });
  const root = f.contentDocument.querySelector('[data-composition-id]');
  dur = parseFloat(root?.getAttribute('data-duration') ?? '1');
  const w = +root?.getAttribute('data-width'), h = +root?.getAttribute('data-height');
  f.width = w; f.height = h;
  const s = Math.min(innerWidth*0.9/w, (innerHeight-60)*0.9/h, 1);
  document.getElementById('stage').style.transform = 'scale('+s+')';
  seek(0);
};
scrub.oninput = () => seek(scrub.value/1000*dur);
document.getElementById('play').onclick = () => {
  playing = !playing;
  document.getElementById('play').textContent = playing ? '⏸' : '▶';
  let last = performance.now();
  const tick = async (now) => {
    if (!playing) return;
    const dt = (now-last)/1000; last = now;
    t += dt; if (t > dur) t = 0;
    await seek(t);
    scrub.value = t/dur*1000;
    raf = requestAnimationFrame(tick);
  };
  if (playing) raf = requestAnimationFrame(tick); else cancelAnimationFrame(raf);
};
<\/script></body>`;
  const outer = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(page);
  });
  await new Promise<void>((r) => outer.listen(0, "127.0.0.1", r));
  const addr = outer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((r) => outer.close(() => r()));
      await inner.close();
    },
  };
}
