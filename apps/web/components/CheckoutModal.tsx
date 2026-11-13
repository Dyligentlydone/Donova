"use client";

import { Loader2, Lock, X } from "lucide-react";
import { useState } from "react";

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CheckoutModal({ isOpen, onClose }: CheckoutModalProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const startCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok || !data.url) {
        throw new Error(data.error || "Failed to start checkout");
      }

      // Stripe-hosted Checkout — returns via /api/billing/confirm.
      window.location.assign(data.url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Checkout failed to start");
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="relative w-full max-w-md bg-[#121212] border border-[#4a8fd8]/40 rounded-2xl shadow-2xl p-6 sm:p-8">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-white/40 hover:text-white transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-[#4a8fd8]/30 bg-[#4a8fd8]/10 text-[#4a8fd8] text-xs font-mono mb-3">
            <Lock className="w-3 h-3" /> Secure Checkout
          </div>
          <h2 className="text-2xl font-extrabold text-white">Join Donova Cloud</h2>
          <p className="text-sm text-white/60 mt-1">
            Automate video editing like a pro for <span className="text-[#4a8fd8] font-bold">$11/month</span>.
          </p>
        </div>

        <form onSubmit={startCheckout} className="space-y-4">
          <div>
            <label htmlFor="checkout-email" className="block text-xs text-white/60 mb-1.5">
              Email Address
            </label>
            <input
              id="checkout-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alex@example.com"
              className="w-full bg-black/60 border border-white/20 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#4a8fd8] transition-colors"
            />
          </div>

          <div className="pt-2">
            <div className="flex justify-between items-center text-sm py-2 border-t border-b border-white/10 mb-4">
              <span className="text-white/70">Creator Monthly Plan</span>
              <span className="text-[#4a8fd8] font-extrabold text-base">$11.00 / mo</span>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#4a8fd8] text-black font-extrabold text-sm tracking-widest py-3.5 rounded-xl hover:bg-[#6aa7f0] disabled:opacity-50 transition-colors flex items-center justify-center gap-2 shadow-[0_0_25px_rgba(74,143,216,0.25)]"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  OPENING CHECKOUT…
                </>
              ) : (
                "PROCEED TO PAYMENT →"
              )}
            </button>
          </div>
        </form>

        {error && <p className="mt-4 text-xs text-red-400 text-center">{error}</p>}

        <p className="mt-4 text-[11px] text-white/40 text-center leading-relaxed">
          Processed securely by Stripe. Cancel anytime from your settings.
        </p>
      </div>
    </div>
  );
}
