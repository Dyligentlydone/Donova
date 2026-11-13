import { requireSubscriber } from "@/lib/auth";
import { signedReadUrl } from "@/lib/project";
import { triggerCloudRender } from "@/lib/storage";
import { userPrefix } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  try {
    const body = await req.json().catch(() => ({}));
    const { bundleKey, bundleUrl, composition, fps } = body;

    // Output always lands inside the caller's own tree — client-supplied
    // outputKey is ignored so no one can write outside their prefix.
    const targetOutput = `${prefix}renders/export_${Date.now()}.mp4`;

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
      downloadUrl: await signedReadUrl(targetOutput, 60 * 60 * 1000),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
