"use client";

import Link from "next/link";
import Image from "next/image";
import { openStudio } from "../lib/openStudio";

interface NavbarProps {
  onSubscribe?: () => void;
  isSubscriber?: boolean;
}

export default function Navbar({ onSubscribe, isSubscriber }: NavbarProps) {
  const handleStudio = async () => {
    const result = await openStudio();
    if (result !== "ok") {
      if (onSubscribe) onSubscribe();
      else window.location.href = "/#pricing";
    }
  };
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#0a0a0a]/80 backdrop-blur-md border-b border-white/10">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <Image
            src="/donova-logo.png"
            alt="Donova"
            width={120}
            height={36}
            className="h-8 w-auto object-contain"
            priority
          />
        </Link>

        <div className="hidden md:flex items-center gap-8 text-sm text-white/70">
          <a href="#features" className="hover:text-white transition-colors">
            Features
          </a>
          <a href="#how-it-works" className="hover:text-white transition-colors">
            How it works
          </a>
          <a href="#pricing" className="hover:text-white transition-colors">
            Pricing
          </a>
          <button
            type="button"
            onClick={() => void handleStudio()}
            className="hover:text-[#4a8fd8] transition-colors"
          >
            Studio
          </button>
        </div>

        <div className="flex items-center gap-3">
          {isSubscriber ? (
            <button
              type="button"
              onClick={() => void handleStudio()}
              className="bg-[#4a8fd8] text-black font-bold text-xs uppercase tracking-wider px-4 py-2.5 rounded-lg hover:bg-[#6aa7f0] transition-colors"
            >
              Open Studio →
            </button>
          ) : (
            <button
              onClick={onSubscribe}
              className="bg-[#4a8fd8] text-black font-extrabold text-xs uppercase tracking-widest px-4 py-2.5 rounded-lg hover:bg-[#6aa7f0] transition-colors shadow-[0_0_20px_rgba(74,143,216,0.2)]"
            >
              Subscribe — $11/mo
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
