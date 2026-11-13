"use client";

import CheckoutModal from "@/components/CheckoutModal";
import Navbar from "@/components/Navbar";
import { ArrowRight, Check, Palette, ShieldCheck, Sparkles, Timer, Type, Zap } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { STUDIO_URL } from "../lib/studioUrl";

export default function Home() {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="relative min-h-screen bg-[#0a0a0a] text-white">
      <Navbar onSubscribe={() => setModalOpen(true)} />

      {/* ── HERO SECTION ── */}
      <section className="pt-32 pb-20 px-4 sm:px-6 max-w-6xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[#4a8fd8]/30 bg-[#4a8fd8]/10 text-[#4a8fd8] text-xs font-mono font-medium mb-6">
            <Sparkles className="w-3.5 h-3.5" />
            Your AI video editor · $11 / month
          </div>

          <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6">
            Edit videos by just <span className="text-[#4a8fd8]">telling it what you want.</span>
          </h1>

          <p className="text-lg sm:text-xl text-white/70 leading-relaxed mb-8 max-w-2xl mx-auto">
            Drop in your raw clips. Describe the edit in plain English. Donova cuts the pauses, adds captions
            in your style, and hands you videos ready for TikTok, Reels, and Shorts.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="w-full sm:w-auto bg-[#4a8fd8] text-black font-extrabold text-sm tracking-widest px-8 py-4 rounded-xl hover:bg-[#6aa7f0] transition-all transform hover:-translate-y-0.5 shadow-[0_0_30px_rgba(74,143,216,0.3)] flex items-center justify-center gap-2"
            >
              START EDITING — $11 / MO
              <ArrowRight className="w-4 h-4" />
            </button>
            <a
              href={STUDIO_URL}
              className="w-full sm:w-auto border border-white/20 text-white/80 hover:text-white font-bold text-sm px-8 py-4 rounded-xl hover:border-white/40 transition-colors text-center"
            >
              See the Studio →
            </a>
          </div>
        </div>

        {/* ── VIDEO HERO SHOWCASE ── */}
        <div className="relative mx-auto max-w-[340px] mt-8 mb-20">
          <div className="rounded-[32px] overflow-hidden border-2 border-[#4a8fd8]/50 bg-black shadow-[0_0_80px_rgba(74,143,216,0.2)]">
            <video
              src="/demo.mp4"
              autoPlay
              muted
              loop
              playsInline
              className="w-full aspect-[9/16] object-cover"
            />
          </div>
          <p className="text-center text-white/40 text-xs mt-4 font-mono tracking-widest">
            RAW CLIP → FINISHED VIDEO · WATCH IT HAPPEN
          </p>
        </div>

        {/* ── 4 PILLARS ── */}
        <div id="features" className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-24">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-[#4a8fd8]/40 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-[#4a8fd8]/10 border border-[#4a8fd8]/30 flex items-center justify-center text-[#4a8fd8] mb-4">
              <Palette className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-lg mb-2">Learns your style</h3>
            <p className="text-sm text-white/60 leading-relaxed">
              Show it one edit — it remembers your fonts, colors, pacing, and caption look. Every video after
              feels like yours.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-[#4a8fd8]/40 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-[#4a8fd8]/10 border border-[#4a8fd8]/30 flex items-center justify-center text-[#4a8fd8] mb-4">
              <Type className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-lg mb-2">Text behind you</h3>
            <p className="text-sm text-white/60 leading-relaxed">
              The signature creator look — captions that slide behind your head — happens automatically. No
              green screen needed.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-[#4a8fd8]/40 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-[#4a8fd8]/10 border border-[#4a8fd8]/30 flex items-center justify-center text-[#4a8fd8] mb-4">
              <Timer className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-lg mb-2">Done in minutes</h3>
            <p className="text-sm text-white/60 leading-relaxed">
              Exports happen on our computers, not yours. Your laptop stays fast and quiet — grab a coffee,
              your video&apos;s ready.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-[#4a8fd8]/40 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-[#4a8fd8]/10 border border-[#4a8fd8]/30 flex items-center justify-center text-[#4a8fd8] mb-4">
              <Zap className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-lg mb-2">Hands-free mode</h3>
            <p className="text-sm text-white/60 leading-relaxed">
              Drop clips in a folder and walk away. Come back to finished videos ready to post.
            </p>
          </div>
        </div>

        {/* ── HOW IT WORKS ── */}
        <div
          id="how-it-works"
          className="max-w-4xl mx-auto rounded-3xl border border-white/10 bg-white/[0.02] p-8 sm:p-12 mb-24"
        >
          <div className="text-center mb-10">
            <p className="text-xs uppercase tracking-widest text-[#4a8fd8] font-mono mb-2">HOW IT WORKS</p>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white">
              From raw clip to posted video in 4 steps
            </h2>
          </div>

          <div className="grid sm:grid-cols-2 gap-6">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full border border-[#4a8fd8] text-[#4a8fd8] flex items-center justify-center font-bold text-sm shrink-0">
                1
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Drop in your clips</h4>
                <p className="text-sm text-white/60">
                  Upload straight from your phone or computer — nothing to install, works in your browser.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full border border-[#4a8fd8] text-[#4a8fd8] flex items-center justify-center font-bold text-sm shrink-0">
                2
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Say what you want</h4>
                <p className="text-sm text-white/60">
                  &quot;Cut the ums and pauses, big text behind me on the hook, captions the whole way.&quot;
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full border border-[#4a8fd8] text-[#4a8fd8] flex items-center justify-center font-bold text-sm shrink-0">
                3
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Watch it happen</h4>
                <p className="text-sm text-white/60">
                  See every change live in your browser. Don&apos;t like something? Just say so — it adjusts.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full border border-[#4a8fd8] text-[#4a8fd8] flex items-center justify-center font-bold text-sm shrink-0">
                4
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Download &amp; post</h4>
                <p className="text-sm text-white/60">
                  Get a finished vertical video sized for TikTok, Reels, and Shorts. That&apos;s it.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── PRICING CARD ($11/mo) ── */}
        <div id="pricing" className="max-w-lg mx-auto mb-20">
          <div className="relative rounded-3xl border-2 border-[#4a8fd8] bg-black/60 backdrop-blur-xl p-8 sm:p-10 shadow-[0_0_60px_rgba(74,143,216,0.15)] text-center">
            <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-[#4a8fd8] text-black font-extrabold text-[10px] tracking-widest px-4 py-1 rounded-full uppercase">
              Creator All-Access
            </div>

            <h3 className="text-2xl font-bold text-white mt-2 mb-1">Donova</h3>
            <p className="text-xs text-white/50 mb-6">Everything you need to post daily</p>

            <div className="flex items-baseline justify-center gap-1 mb-6">
              <span className="text-5xl font-black text-[#4a8fd8]">$11</span>
              <span className="text-white/50 text-sm font-medium">/ month</span>
            </div>

            <ul className="space-y-3.5 text-sm text-left mb-8 max-w-xs mx-auto text-white/80">
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Unlimited finished videos</span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Text-behind-you effect, built in</span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Your style, remembered — every edit gets more you</span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Your footage stays in your private workspace</span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Hands-free mode: drop a clip, get a video</span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Cancel or pause anytime</span>
              </li>
            </ul>

            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="w-full bg-[#4a8fd8] text-black font-extrabold text-sm tracking-widest py-4 rounded-xl hover:bg-[#6aa7f0] transition-all shadow-[0_0_25px_rgba(74,143,216,0.25)]"
            >
              START EDITING — $11/MO
            </button>

            <div className="flex items-center justify-center gap-1.5 text-[11px] text-white/40 mt-4">
              <ShieldCheck className="w-3.5 h-3.5 text-[#4a8fd8]" />
              Secure checkout · Cancel anytime · No contracts
            </div>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-white/10 py-10 px-4 text-center text-xs text-white/40">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Image
              src="/donova-logo.png"
              alt="Donova"
              width={90}
              height={26}
              className="h-6 w-auto opacity-70"
            />
            <span>· Your AI video editor</span>
          </div>
          <div>© {new Date().getFullYear()} Donova. All rights reserved.</div>
        </div>
      </footer>

      {/* ── STRIPE CHECKOUT MODAL ── */}
      <CheckoutModal isOpen={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
