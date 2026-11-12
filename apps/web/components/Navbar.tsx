"use client";

import Link from "next/link";
import Image from "next/image";

interface NavbarProps {
  onSubscribe?: () => void;
  isSubscriber?: boolean;
}

export default function Navbar({ onSubscribe, isSubscriber }: NavbarProps) {
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
          <Link href="/studio" className="hover:text-[#d7b73f] transition-colors">
            Studio
          </Link>
        </div>

        <div className="flex items-center gap-3">
          {isSubscriber ? (
            <Link
              href="/studio"
              className="bg-[#d7b73f] text-black font-bold text-xs uppercase tracking-wider px-4 py-2.5 rounded-lg hover:bg-[#e9cf6b] transition-colors"
            >
              Open Studio →
            </Link>
          ) : (
            <button
              onClick={onSubscribe}
              className="bg-[#d7b73f] text-black font-extrabold text-xs uppercase tracking-widest px-4 py-2.5 rounded-lg hover:bg-[#e9cf6b] transition-colors shadow-[0_0_20px_rgba(215,183,63,0.2)]"
            >
              Subscribe — $11/mo
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
