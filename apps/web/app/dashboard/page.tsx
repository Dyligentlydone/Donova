"use client";

import {
  ArrowLeft,
  CheckCircle,
  Download,
  Film,
  Loader2,
  Play,
  Server,
  Sparkles,
  Upload,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { openStudio } from "../../lib/openStudio";
import { useState } from "react";

export default function Dashboard() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<{
    ok: boolean;
    jobId?: string;
    downloadUrl?: string;
    frames?: number;
    duration?: number;
    error?: string;
  } | null>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", selected);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to upload footage to GCS");
      }

      setUploadedUrl(data.projectPath ?? data.fileKey);
    } catch (err: unknown) {
      alert(`Upload error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleTriggerRender = async () => {
    setRendering(true);
    setRenderResult(null);

    try {
      const res = await fetch("/api/renders/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundleKey: "test-bundles/basic.zip",
          outputKey: `renders/export_${Date.now()}.mp4`,
          composition: "index.html",
          fps: 30,
        }),
      });

      const data = await res.json();
      setRenderResult(data);
    } catch (err: unknown) {
      setRenderResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Top bar */}
      <header className="border-b border-white/10 bg-[#0e0e0e] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-white/60 hover:text-white flex items-center gap-1.5 text-xs font-mono"
          >
            <ArrowLeft className="w-4 h-4" /> Home
          </Link>
          <div className="h-4 w-px bg-white/20" />
          <Image
            src="/donova-logo.png"
            alt="Donova"
            width={100}
            height={28}
            className="h-6 w-auto object-contain"
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Creator Plan ($11/mo) Active
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white">Creator Studio Workspace</h1>
            <p className="text-sm text-white/60 mt-1">
              Connected to Google Cloud Run · Bucket:{" "}
              <code className="text-[#d7b73f]">donova-renders-donova-514500</code>
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                void openStudio().then((r) => {
                  if (r !== "ok") window.location.href = "/#pricing";
                });
              }}
              className="bg-[#d7b73f] text-black font-extrabold text-xs uppercase tracking-widest px-6 py-3 rounded-xl hover:bg-[#e9cf6b] transition-all flex items-center gap-2 shadow-[0_0_20px_rgba(215,183,63,0.25)]"
            >
              <Film className="w-4 h-4" />
              OPEN DONOVA STUDIO →
            </button>
            <button
              type="button"
              onClick={handleTriggerRender}
              disabled={rendering}
              className="border border-white/20 text-white font-bold text-xs uppercase tracking-widest px-5 py-3 rounded-xl hover:border-white/40 transition-colors flex items-center gap-2"
            >
              {rendering ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  RENDERING...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  TEST CLOUD EXPORT
                </>
              )}
            </button>
          </div>
        </div>

        {/* Status banner when render succeeds */}
        {renderResult?.ok && (
          <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6 mb-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="w-8 h-8 text-emerald-400 shrink-0" />
              <div>
                <h3 className="font-bold text-white text-base">Video Rendered Successfully on Cloud Run!</h3>
                <p className="text-xs text-white/70">
                  {renderResult.frames} frames · {renderResult.duration}s runtime · Saved directly to Google
                  Cloud Storage.
                </p>
              </div>
            </div>

            {renderResult.downloadUrl && (
              <a
                href={renderResult.downloadUrl}
                download
                target="_blank"
                rel="noreferrer"
                className="bg-white text-black font-extrabold text-xs uppercase tracking-widest px-5 py-2.5 rounded-lg hover:bg-white/90 transition-colors flex items-center gap-1.5 shrink-0"
              >
                <Download className="w-4 h-4" />
                DOWNLOAD MP4
              </a>
            )}
          </div>
        )}

        {renderResult && !renderResult.ok && (
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-5 mb-8 text-sm text-red-300">
            Render failed: {renderResult.error}
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-8">
          {/* Upload card */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2 text-[#d7b73f]">
                <Upload className="w-5 h-5" />
                <h2 className="font-bold text-lg text-white">Upload Raw Footage</h2>
              </div>
              <p className="text-xs text-white/60 mb-6">
                Direct-to-cloud upload. Files stream straight to your Google Cloud Storage bucket via secure
                signed URLs.
              </p>

              <label className="border-2 border-dashed border-white/20 hover:border-[#d7b73f]/60 rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-colors block bg-black/40">
                <input
                  type="file"
                  accept="video/*"
                  onChange={handleUpload}
                  disabled={uploading}
                  className="hidden"
                />
                <Film className="w-10 h-10 text-white/40 mb-3" />
                <span className="text-sm font-bold text-white mb-1">
                  {uploading ? "Uploading to Cloud Storage..." : file ? file.name : "Choose raw video file"}
                </span>
                <span className="text-xs text-white/40">MP4, MOV, or WebM up to 4K</span>
              </label>
            </div>

            {uploadedUrl && (
              <div className="mt-4 p-3 bg-black/60 border border-white/10 rounded-xl text-xs flex items-center justify-between text-white/70">
                <span className="truncate pr-2">✓ Staged in GCS</span>
                <span className="text-[#d7b73f] font-mono shrink-0">Ready for Edit</span>
              </div>
            )}
          </div>

          {/* Cloud Worker Card */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2 text-[#d7b73f]">
                <Server className="w-5 h-5" />
                <h2 className="font-bold text-lg text-white">Cloud Run Engine</h2>
              </div>
              <p className="text-xs text-white/60 mb-6">
                Headless Chrome and FFmpeg compute cluster. Renders with deterministic frame step-control.
              </p>

              <div className="space-y-3 text-xs bg-black/50 border border-white/10 rounded-xl p-4 font-mono">
                <div className="flex justify-between py-1 border-b border-white/5">
                  <span className="text-white/50">Worker Host</span>
                  <span className="text-emerald-400">Cloud Run us-central1</span>
                </div>
                <div className="flex justify-between py-1 border-b border-white/5">
                  <span className="text-white/50">Matte Engine</span>
                  <span className="text-white">MODNet (512x512)</span>
                </div>
                <div className="flex justify-between py-1 border-b border-white/5">
                  <span className="text-white/50">Encoder</span>
                  <span className="text-white">FFmpeg 7 / H.264 High</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-white/50">Output Target</span>
                  <span className="text-[#d7b73f]">gs://donova-renders-donova-514500</span>
                </div>
              </div>
            </div>

            <div className="mt-6">
              <button
                type="button"
                onClick={handleTriggerRender}
                disabled={rendering}
                className="w-full bg-white/10 hover:bg-white/20 text-white font-bold text-xs uppercase tracking-wider py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {rendering ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-[#d7b73f]" />
                    Processing on Cloud Run...
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    Test Cloud Render
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
