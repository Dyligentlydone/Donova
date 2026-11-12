import { NextResponse } from "next/server";
import { triggerCloudRender } from "@/lib/storage";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { bundleKey, bundleUrl, outputKey, composition, fps } = body;

    const targetOutput = outputKey || `renders/export_${Date.now()}.mp4`;

    const res = await triggerCloudRender({
      bundleKey: bundleKey || "test-bundles/basic.zip",
      bundleUrl,
      outputKey: targetOutput,
      composition: composition || "index.html",
      fps: fps || 30,
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: res.error || "Render worker failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      jobId: res.jobId,
      destination: res.destination,
      size: res.size,
      frames: res.frames,
      duration: res.duration,
      downloadUrl: `https://storage.googleapis.com/${process.env.DONOVA_BUCKET || "donova-renders-donova-514500"}/${targetOutput}`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
