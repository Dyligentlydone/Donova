import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** `framecraft init` — scaffold a new project (06 §init). */
export async function initProject(
  dir: string,
  opts?: {
    name?: string;
    width?: number;
    height?: number;
    duration?: number;
    fps?: number;
    /** Footage project: copy media into assets/, scaffold segments (17 §3.6). */
    footage?: string;
  },
): Promise<string[]> {
  const root = resolve(dir);
  const name = opts?.name ?? "framecraft-project";
  const w = opts?.width ?? 1920;
  const h = opts?.height ?? 1080;
  const d = opts?.duration ?? 5;
  const fps = opts?.fps ?? 30;
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "compositions"), { recursive: true });
  await mkdir(join(root, "media"), { recursive: true });

  if (opts?.footage) {
    // Footage project: copy media under assets/ so the file server + agent
    // tools see it inside the project root (17 §3.6).
    const mediaAbs = resolve(opts.footage);
    const assetsDir = join(root, "assets");
    await mkdir(assetsDir, { recursive: true });
    const { copyFile } = await import("node:fs/promises");
    await copyFile(mediaAbs, join(assetsDir, basename(mediaAbs)));

    const { locateFfmpeg, probe } = await import("@framecraft/engine");
    const { scaffoldFootage } = await import("@framecraft/media");
    const { ffprobe } = await locateFfmpeg();
    const p = await probe(ffprobe, mediaAbs);
    const rot = Math.abs(p.rotation ?? 0);
    const sw = p.width ?? 1920;
    const sh = p.height ?? 1080;
    const dispW = rot === 90 || rot === 270 ? sh : sw;
    const dispH = rot === 90 || rot === 270 ? sw : sh;
    const html = scaffoldFootage({
      source: `assets/${basename(mediaAbs)}`,
      outWidth: opts?.width ?? dispW,
      outHeight: opts?.height ?? dispH,
      plan: {
        version: 1,
        source: basename(mediaAbs),
        silenceThreshold: 0,
        pad: 0,
        sourceDuration: p.duration,
        duration: p.duration,
        removed: 0,
        segments: [
          {
            srcStart: 0,
            srcEnd: p.duration,
            compStart: 0,
            duration: p.duration,
            wordStart: 0,
            wordEnd: -1,
          },
        ],
      },
      fps,
    });
    await writeFile(join(root, "index.html"), html);
    const config = {
      $schema: "https://framecraft.dev/schemas/project.schema.json",
      id: name,
      name,
      composition: "index.html",
      fps,
      width: opts?.width ?? sw,
      height: opts?.height ?? sh,
      render: { format: "mp4", quality: "standard", codec: "h264", alpha: false },
    };
    await writeFile(join(root, "framecraft.json"), `${JSON.stringify(config, null, 2)}\n`);
    return ["index.html", "framecraft.json", `assets/${basename(mediaAbs)}`];
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: #0b0e14; overflow: hidden; }
  #root { position: relative; width: ${w}px; height: ${h}px; }
  .clip { position: absolute; inset: 0; }
  .title { position: absolute; left: 8%; top: 40%; font: 800 ${Math.round(h / 9)}px/1.1 system-ui; color: #fff; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-width="${w}" data-height="${h}" data-duration="${d}" data-fps="${fps}">
  <div class="clip" data-start="0" data-duration="${d}">
    <div class="title"
      data-fc-motion='{"v":1,"split":"words","stagger":0.08,"anims":[{"t":0,"dur":0.8,"ease":"power3.out","props":{"opacity":[0,1],"translateY":["0.6em","0em"]}}]}'>
      Hello Framecraft
    </div>
  </div>
</div>
</body>
</html>
`;

  const config = {
    $schema: "https://framecraft.dev/schemas/project.schema.json",
    id: name,
    name,
    composition: "index.html",
    fps,
    width: w,
    height: h,
    render: { format: "mp4", quality: "standard", codec: "h264", alpha: false },
  };

  await writeFile(join(root, "index.html"), html);
  await writeFile(join(root, "framecraft.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(
    join(root, "AGENTS.md"),
    `# ${name}\n\nFramecraft project. Composition: index.html.\n\n- Lint: \`framecraft check\`\n- Preview: \`framecraft preview\`\n- Render: \`framecraft render --out out.mp4\`\n\nContract: timed elements carry data-start + data-duration (+ class="clip").\nRegister one paused GSAP timeline on window.__timelines["main"] when animating with GSAP code.\nStudio-authored animation uses data-fc-motion (never hand-edited GSAP).\n`,
  );
  return ["index.html", "framecraft.json", "AGENTS.md", "compositions/", "media/"];
}
