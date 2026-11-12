import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { render, type RenderResult } from "@donova/producer";
import { downloadAndExtractBundle, uploadRenderOutput, type UploadResult } from "./storage.js";

export interface RenderJobParams {
  jobId?: string;
  bucket?: string;
  bundleKey?: string;
  bundleUrl?: string;
  /** GCS prefix holding an unpacked project tree (alternative to a bundle archive). */
  projectPrefix?: string;
  outputKey?: string;
  uploadUrl?: string;
  composition?: string;
  fps?: number;
  quality?: "draft" | "standard" | "high";
  format?: "mp4" | "webm";
  workers?: number;
}

export interface RenderJobResult {
  ok: boolean;
  jobId: string;
  destination: string;
  size: number;
  frames: number;
  fps: number;
  duration: number;
  width: number;
  height: number;
  stages?: Record<string, number>;
  totalTimeMs: number;
}

export async function executeRenderJob(params: RenderJobParams): Promise<RenderJobResult> {
  const t0 = Date.now();
  const jobId = params.jobId ?? `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const workDir = join("/tmp", "donova-jobs", jobId);
  const projectExtractDir = join(workDir, "project");
  const outputFile = join(workDir, `output.${params.format ?? "mp4"}`);

  try {
    // 1. Download & extract project bundle
    const bucket = params.bucket ?? process.env.DONOVA_BUCKET;
    console.log(`[${jobId}] downloading bundle...`);
    await downloadAndExtractBundle({
      bucket,
      bundleKey: params.bundleKey,
      bundleUrl: params.bundleUrl,
      projectPrefix: params.projectPrefix,
      destDir: projectExtractDir,
    });

    // 2. Locate project root (handle archives with a single root directory)
    let projectDir = projectExtractDir;
    const compFile = params.composition ?? "index.html";
    if (!existsSync(join(projectDir, compFile))) {
      const entries = await readdir(projectExtractDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());
      if (dirs.length === 1 && dirs[0]) {
        const nestedDir = join(projectExtractDir, dirs[0].name);
        if (existsSync(join(nestedDir, compFile))) {
          projectDir = nestedDir;
        }
      }
    }

    if (!existsSync(join(projectDir, compFile))) {
      throw new Error(`Composition file '${compFile}' not found in project bundle at ${projectDir}`);
    }

    // 3. Render
    console.log(`[${jobId}] rendering ${compFile} in ${projectDir}...`);
    const renderRes: RenderResult = await render({
      projectDir,
      composition: compFile,
      out: outputFile,
      fps: params.fps,
      quality: params.quality ?? "standard",
      workers: params.workers ?? 1,
      format: params.format ?? "mp4",
    });

    console.log(
      `[${jobId}] render complete: ${renderRes.frames} frames (${renderRes.duration.toFixed(2)}s) at ${renderRes.fps}fps`,
    );

    // 4. Upload output
    console.log(`[${jobId}] uploading rendered output...`);
    const uploadRes: UploadResult = await uploadRenderOutput({
      filePath: outputFile,
      bucket,
      outputKey: params.outputKey,
      uploadUrl: params.uploadUrl,
    });

    const totalTimeMs = Date.now() - t0;
    console.log(`[${jobId}] done in ${totalTimeMs}ms -> ${uploadRes.destination}`);

    return {
      ok: true,
      jobId,
      destination: uploadRes.destination,
      size: uploadRes.size,
      frames: renderRes.frames,
      fps: renderRes.fps,
      duration: renderRes.duration,
      width: renderRes.width,
      height: renderRes.height,
      stages: renderRes.stages,
      totalTimeMs,
    };
  } finally {
    // 5. Cleanup temp files
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (cleanErr) {
      console.warn(`[${jobId}] cleanup warning:`, cleanErr);
    }
  }
}
