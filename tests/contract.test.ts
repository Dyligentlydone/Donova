import { describe, expect, it } from "vitest";
import { formatTimecode, parseCompositionHtml, parseMotionAttr, parseTime, planRender, resolveTimeline } from "../packages/contract/src/index.js";

describe("parseTime", () => {
  it("parses seconds", () => expect(parseTime("1.5")).toBe(1.5));
  it("parses mm:ss", () => expect(parseTime("1:30")).toBe(90));
  it("parses ms", () => expect(parseTime("500ms")).toBe(0.5));
  it("parses frames with fps", () => expect(parseTime("30f", 30)).toBe(1));
  it("parses hh:mm:ss", () => expect(parseTime("1:00:30")).toBe(3630));
  it("rejects garbage", () => expect(parseTime("abc")).toBeUndefined());
});

const HTML = `<!doctype html><div data-composition-id="main" data-width="640" data-height="360" data-duration="4">
  <div class="clip" data-start="0" data-duration="2"><video src="a.mp4" muted data-has-audio="false"></video></div>
  <div class="clip" data-start="2" data-duration="2"><audio src="m.aac" data-audio-offset="0.5" data-volume="0.8"></audio></div>
  <div class="clip" data-start="1" data-end="3" data-fc-motion='{"v":1,"anims":[{"t":0,"dur":0.5,"props":{"opacity":[0,1]}}]}'></div>
</div>`;

describe("parseCompositionHtml", () => {
  const { spec } = parseCompositionHtml(HTML);
  it("reads root dims", () => {
    expect(spec.width).toBe(640);
    expect(spec.duration).toBe(4);
  });
  it("collects 3 clips", () => expect(spec.clips.length).toBe(3));
  it("collects nested media items", () => {
    expect(spec.mediaItems.length).toBe(2);
    expect(spec.mediaItems[0]?.kind).toBe("video");
    expect(spec.mediaItems[1]?.kind).toBe("audio");
  });
  it("end-derived duration", () => expect(spec.clips[2]?.timing.duration).toBe(2) /* data-end − data-start */);
  it("flags no errors", () => expect(spec.errors.length).toBe(0));
});

describe("resolveTimeline + planRender", () => {
  const { spec } = parseCompositionHtml(HTML);
  const tl = resolveTimeline(spec);
  it("produces cut boundaries", () => {
    expect(tl.cuts).toContain(0);
    expect(tl.cuts).toContain(2);
  });
  it("plans segments and frames", () => {
    const plan = planRender(spec, tl, { fps: 30 });
    expect(plan.totalFrames).toBe(120);
    const total = plan.segments.reduce((a, s) => a + s.frameCount, 0);
    expect(total).toBe(120);
  });
});

describe("parseMotionAttr", () => {
  it("parses valid spec", () => {
    const { spec, issues } = parseMotionAttr('{"v":1,"anims":[{"t":0,"dur":0.5,"ease":"power2.out","props":{"opacity":[0,1]}}]}');
    expect(issues.length).toBe(0);
    expect(spec?.anims[0]?.dur).toBe(0.5);
  });
  it("rejects bad json", () => {
    expect(parseMotionAttr("{nope").issues[0]?.rule).toBe("motion-json");
  });
  it("rejects bad ease", () => {
    const r = parseMotionAttr('{"v":1,"anims":[{"t":0,"dur":1,"ease":"nope","props":{}}]}');
    expect(r.issues[0]?.rule).toBe("motion-ease");
  });
});

describe("formatTimecode", () => {
  it("formats", () => expect(formatTimecode(90.5)).toBe("01:30.500"));
});
