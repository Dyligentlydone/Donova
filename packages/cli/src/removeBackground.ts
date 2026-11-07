import { removeBackgroundImage, removeBackgroundVideo } from "@framecraft/media";

/** `framecraft remove-background` — image→PNG alpha, video→WebM alpha (MV8). */
export async function removeBackgroundCmd(opts: {
  media: string;
  out?: string;
  start?: number;
  end?: number;
  smoothing?: number;
}): Promise<{ path: string; kind: "image" | "video"; frames?: number }> {
  const isImage = /\.(png|jpe?g|webp)$/i.test(opts.media);
  if (isImage) {
    const out = opts.out ?? opts.media.replace(/\.[^.]+$/, "") + "-cutout.png";
    const r = await removeBackgroundImage(opts.media, out);
    return { ...r, kind: "image" };
  }
  const out = opts.out ?? opts.media.replace(/\.[^.]+$/, "") + "-cutout.webm";
  const r = await removeBackgroundVideo({
    input: opts.media,
    out,
    start: opts.start,
    end: opts.end,
    smoothing: opts.smoothing,
  });
  return { ...r, kind: "video" };
}
