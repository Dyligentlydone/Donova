"use client";

import HelcimModal from "@/components/HelcimModal";
import Navbar from "@/components/Navbar";
import { ArrowRight, Check, Cpu, Layers, ShieldCheck, Sparkles, Wand2, Zap } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

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
            Vibe Editing on Google Cloud · $11 / month
          </div>

          <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6">
            Learn &amp; get the tools to <span className="text-[#4a8fd8]">automate editing videos</span> like
            a professional.
          </h1>

          <p className="text-lg sm:text-xl text-white/70 leading-relaxed mb-8 max-w-2xl mx-auto">
            Upload your raw talking clips. Tell your AI editor what you want. Donova applies your custom style
            bible, cuts the dead air, keys your background, and renders ready-to-post MP4s in minutes.
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
            <Link
              href="/studio"
              className="w-full sm:w-auto border border-white/20 text-white/80 hover:text-white font-bold text-sm px-8 py-4 rounded-xl hover:border-white/40 transition-colors text-center"
            >
              Open Studio Editor →
            </Link>
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
            THE 1-MINUTE CLOUD WORKFLOW IN ACTION
          </p>
        </div>

        {/* ── 4 PILLARS ── */}
        <div id="features" className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-24">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-[#4a8fd8]/40 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-[#4a8fd8]/10 border border-[#4a8fd8]/30 flex items-center justify-center text-[#4a8fd8] mb-4">
              <Wand2 className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-lg mb-2">Style Bible</h3>
            <p className="text-sm text-white/60 leading-relaxed">
              Teach it your fonts, pacing, and caption aesthetic once in{" "}
              <code className="text-[#4a8fd8]">style.md</code>. Every future video reflects your signature
              look.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-[#4a8fd8]/40 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-[#4a8fd8]/10 border border-[#4a8fd8]/30 flex items-center justify-center text-[#4a8fd8] mb-4">
              <Layers className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-lg mb-2">MODNet Cutouts</h3>
            <p className="text-sm text-white/60 leading-relaxed">
              Deep-learning human segmentation creates soft, natural hair and shoulder alpha mattes for
              text-behind-subject effects without green screens.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-[#4a8fd8]/40 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-[#4a8fd8]/10 border border-[#4a8fd8]/30 flex items-center justify-center text-[#4a8fd8] mb-4">
              <Cpu className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-lg mb-2">Google Cloud Renders</h3>
            <p className="text-sm text-white/60 leading-relaxed">
              No fan noise or battery drain. Frame-accurate renders execute on high-speed headless Cloud Run
              worker containers in seconds.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-[#4a8fd8]/40 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-[#4a8fd8]/10 border border-[#4a8fd8]/30 flex items-center justify-center text-[#4a8fd8] mb-4">
              <Zap className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-lg mb-2">Auto Donova</h3>
            <p className="text-sm text-white/60 leading-relaxed">
              Drop clips in your raw folder and walk away. Auto mode inspects, cuts, layers, and places
              exported MP4s directly into your renders hub.
            </p>
          </div>
        </div>

        {/* ── HOW IT WORKS ── */}
        <div
          id="how-it-works"
          className="max-w-4xl mx-auto rounded-3xl border border-white/10 bg-white/[0.02] p-8 sm:p-12 mb-24"
        >
          <div className="text-center mb-10">
            <p className="text-xs uppercase tracking-widest text-[#4a8fd8] font-mono mb-2">THE WORKFLOW</p>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white">
              From phone footage to export in 4 steps
            </h2>
          </div>

          <div className="grid sm:grid-cols-2 gap-6">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full border border-[#4a8fd8] text-[#4a8fd8] flex items-center justify-center font-bold text-sm shrink-0">
                1
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Drop in raw clips</h4>
                <p className="text-sm text-white/60">
                  Upload raw phone footage to your secure cloud bucket with zero local storage requirements.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full border border-[#4a8fd8] text-[#4a8fd8] flex items-center justify-center font-bold text-sm shrink-0">
                2
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Describe your edit</h4>
                <p className="text-sm text-white/60">
                  Say &quot;hook with big gold text behind me, tight jump cuts, and synced captions.&quot;
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full border border-[#4a8fd8] text-[#4a8fd8] flex items-center justify-center font-bold text-sm shrink-0">
                3
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Live Studio Review</h4>
                <p className="text-sm text-white/60">
                  Preview changes in real time in the Donova Studio player. Tweak timing or add annotations
                  with one click.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full border border-[#4a8fd8] text-[#4a8fd8] flex items-center justify-center font-bold text-sm shrink-0">
                4
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Cloud Render &amp; Download</h4>
                <p className="text-sm text-white/60">
                  Export directly on Google Cloud Run. Download high-bitrate 1080x1920 MP4s ready for TikTok,
                  Reels, or Shorts.
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

            <h3 className="text-2xl font-bold text-white mt-2 mb-1">Donova Cloud</h3>
            <p className="text-xs text-white/50 mb-6">Complete AI video editing suite</p>

            <div className="flex items-baseline justify-center gap-1 mb-6">
              <span className="text-5xl font-black text-[#4a8fd8]">$11</span>
              <span className="text-white/50 text-sm font-medium">/ month</span>
            </div>

            <ul className="space-y-3.5 text-sm text-left mb-8 max-w-xs mx-auto text-white/80">
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Unlimited cloud video exports</span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>MODNet AI background removal</span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>
                  Personal Style Bible (<code className="text-xs text-[#4a8fd8]">style.md</code>)
                </span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Google Cloud Storage asset hosting</span>
              </li>
              <li className="flex items-center gap-3">
                <Check className="w-4 h-4 text-[#4a8fd8] shrink-0" />
                <span>Auto Donova drop-to-edit mode</span>
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
              SUBSCRIBE WITH HELCIM — $11/MO
            </button>

            <div className="flex items-center justify-center gap-1.5 text-[11px] text-white/40 mt-4">
              <ShieldCheck className="w-3.5 h-3.5 text-[#4a8fd8]" />
              Interchange-Plus secure billing · No commitments
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
            <span>· Next-Gen Cloud Video Editor</span>
          </div>
          <div>© {new Date().getFullYear()} Donova. All rights reserved.</div>
        </div>
      </footer>

      {/* ── HELCIM CHECKOUT MODAL ── */}
      <HelcimModal isOpen={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
