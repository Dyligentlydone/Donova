import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { locateFfmpeg, probe } from "../../packages/engine/src/index.js";
import { render } from "../../packages/producer/src/index.js";

const REPO = resolve(__dirname, "..", "..");
const BASIC = join(REPO, "fixtures", "basic");
const MEDIA = join(REPO, "fixtures", "media");

let work: string;
afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

async function sha256(p: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
}

describe("golden: render determinism", () => {
  it("renders the basic fixture byte-identically twice", async () => {
    work = await mkdtemp(join(tmpdir(), "fc-golden-"));
    const a = join(work, "a.mp4");
    const b = join(work, "b.mp4");
    await render({ projectDir: BASIC, out: a, quality: "draft" });
    await render({ projectDir: BASIC, out: b, quality: "draft" });
    expect(await sha256(a)).toBe(await sha256(b));
  });
});

describe("golden: media fixture", () => {
  it("renders the video fixture at spec dims/duration with audio", async () => {
    work = await mkdtemp(join(tmpdir(), "fc-golden-"));
    const out = join(work, "media.mp4");
    const res = await render({ projectDir: MEDIA, out, quality: "draft" });
    const { ffprobe } = await locateFfmpeg();
    const p = await probe(ffprobe, out);
    expect(res.width).toBe(640);
    expect(res.height).toBe(360);
    expect(p.hasAudio).toBe(true);
    expect(Math.abs(p.duration - res.duration)).toBeLessThan(0.15);
  });
});
