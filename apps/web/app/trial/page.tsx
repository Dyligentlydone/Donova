"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { useState } from "react";

export default function TrialPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/trial", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (res.status === 403 && data.error === "trial-ended") {
        setEnded(true);
        return;
      }
      if (!res.ok || !data.ok || !data.url) {
        setError(
          data.error === "invalid-email"
            ? "That doesn't look like an email — check it and try again."
            : "Something went wrong — try again in a moment.",
        );
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Something went wrong — try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6 py-20 text-center">
      <Image
        src="/donova-logo.png"
        alt="Donova"
        width={140}
        height={38}
        className="mb-10"
        priority
      />
      <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[#4a8fd8]/30 bg-[#4a8fd8]/10 text-[#4a8fd8] text-xs font-mono font-medium mb-6">
        <Sparkles className="w-3.5 h-3.5" />
        FREE 7-DAY TRIAL — NO CARD
      </div>
      <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6 max-w-3xl">
        Try Donova free for <span className="text-[#4a8fd8]">7 days.</span>
      </h1>
      <p className="text-lg sm:text-xl text-white/70 leading-relaxed mb-10 max-w-2xl">
        Drop in your raw clips, describe the edit in plain English, and get a
        finished video back. Nothing to install — your week starts the second
        you hit go.
      </p>

      {ended ? (
        <div className="max-w-md rounded-2xl border border-[#4a8fd8]/30 bg-[#4a8fd8]/5 p-8">
          <h2 className="text-2xl font-extrabold mb-3">Your free week is up</h2>
          <p className="text-white/60 mb-6">
            Keep your style guide, your videos, and your access —{" "}
            <b className="text-white">$11/mo</b>, cancel anytime.
          </p>
          <Link
            href="/#pricing"
            className="inline-flex items-center justify-center gap-2 bg-[#4a8fd8] text-black font-extrabold text-sm tracking-widest px-8 py-4 rounded-xl hover:bg-[#6aa7f0] transition-all shadow-[0_0_30px_rgba(74,143,216,0.3)]"
          >
            SUBSCRIBE — $11/MO <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      ) : (
        <form
          className="w-full max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-5 py-4 text-white placeholder-white/30 outline-none focus:border-[#4a8fd8]/60 focus:ring-2 focus:ring-[#4a8fd8]/20 mb-4"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-[#4a8fd8] text-black font-extrabold text-sm tracking-widest px-8 py-4 rounded-xl hover:bg-[#6aa7f0] transition-all transform hover:-translate-y-0.5 shadow-[0_0_30px_rgba(74,143,216,0.3)] disabled:opacity-50 disabled:translate-y-0 flex items-center justify-center gap-2"
          >
            {busy ? "SETTING UP YOUR WORKSPACE…" : "START MY FREE WEEK"}
            {!busy && <ArrowRight className="w-4 h-4" />}
          </button>
          {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
          <p className="text-white/30 text-xs mt-5 font-mono">
            No credit card · Takes about 10 seconds
          </p>
        </form>
      )}

      <Link
        href="/"
        className="mt-12 text-white/40 hover:text-white/70 text-sm transition-colors"
      >
        ← Back to donova
      </Link>
    </main>
  );
}
