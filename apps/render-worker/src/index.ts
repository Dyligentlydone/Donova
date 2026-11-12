import { executeRenderJob, type RenderJobParams } from "./job.js";
import { startHttpServer } from "./server.js";

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      if (key) {
        result[key] = rest.join("=") || "true";
      }
    }
  }
  return result;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const isJob = flags.job === "true" || process.env.DONOVA_JOB === "1" || flags.bundleKey || flags.bundleUrl;

  if (isJob) {
    console.log("Starting Donova render worker in batch job mode...");
    const params: RenderJobParams = {
      jobId: flags.jobId ?? process.env.DONOVA_JOB_ID,
      bucket: flags.bucket ?? process.env.DONOVA_BUCKET,
      bundleKey: flags.bundleKey ?? process.env.DONOVA_BUNDLE_KEY,
      bundleUrl: flags.bundleUrl ?? process.env.DONOVA_BUNDLE_URL,
      outputKey: flags.outputKey ?? process.env.DONOVA_OUTPUT_KEY,
      uploadUrl: flags.uploadUrl ?? process.env.DONOVA_UPLOAD_URL,
      composition: flags.composition ?? process.env.DONOVA_COMPOSITION,
      fps: flags.fps ? Number(flags.fps) : undefined,
      quality: (flags.quality as "draft" | "standard" | "high") ?? undefined,
      workers: flags.workers ? Number(flags.workers) : undefined,
    };

    try {
      const result = await executeRenderJob(params);
      console.log("Job succeeded:", JSON.stringify(result));
      process.exit(0);
    } catch (err) {
      console.error("Job failed:", err);
      process.exit(1);
    }
  } else {
    // Start HTTP server on $PORT (default 8080)
    const port = Number(process.env.PORT || 8080);
    startHttpServer(port);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
