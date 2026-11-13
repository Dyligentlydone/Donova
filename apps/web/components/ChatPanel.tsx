"use client";

import { Loader2, MessageSquare, RotateCcw, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface TurnView {
  id: string;
  message: string;
  reply: string;
  changes: Array<{ file: string }>;
}

/**
 * The vibe-edit chat — POSTs /api/chat (auth + caps enforced server-side),
 * shows the agent's reply + which files it touched, and exposes undo.
 * Turns persist in .donova/turns.json under the user's project prefix.
 */
export default function ChatPanel() {
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [sending, setSending] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch("/api/turns")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.turns) setTurns(d.turns as TurnView[]);
      })
      .catch(() => {});
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll fires on turn/send changes, not on their values
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, sending]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `chat failed (${res.status})`);
      if (typeof data.chatRemaining === "number") setRemaining(data.chatRemaining);
      setTurns((t) => [
        ...t,
        {
          id: data.id ?? `turn-${t.length + 1}`,
          message: text,
          reply: data.reply ?? "Done.",
          changes: data.changes ?? [],
        },
      ]);
      setMessage("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Chat failed");
    } finally {
      setSending(false);
    }
  };

  const undo = async () => {
    const res = await fetch("/api/undo", { method: "POST" });
    const data = await res.json().catch(() => null);
    if (data?.ok) {
      setTurns((t) => t.filter((x) => !data.restored?.length || x.changes.length === 0));
      void fetch("/api/turns")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.turns && setTurns(d.turns as TurnView[]))
        .catch(() => {});
    }
  };

  return (
    <div className="rounded-2xl border border-[#4a8fd8]/30 bg-white/[0.02] p-6 flex flex-col h-[560px]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-[#4a8fd8]">
          <Sparkles className="w-5 h-5" />
          <h2 className="font-bold text-lg text-white">AI Editing Agent</h2>
        </div>
        <div className="flex items-center gap-3">
          {remaining != null && remaining >= 0 && (
            <span className="text-[11px] font-mono text-white/50">{remaining} chats left</span>
          )}
          <button
            type="button"
            onClick={undo}
            title="Undo the last file-changing edit"
            className="text-white/40 hover:text-white transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div ref={feedRef} className="flex-1 overflow-y-auto space-y-3 mb-4 pr-1 text-sm leading-relaxed">
        {turns.length === 0 && !sending && (
          <div className="text-white/40 text-xs mt-8 text-center space-y-2">
            <MessageSquare className="w-8 h-8 mx-auto text-white/20" />
            <p>Describe an edit in plain English.</p>
            <p className="text-white/30">
              Try: &ldquo;transcribe my footage&rdquo;, &ldquo;cut the dead air&rdquo;, &ldquo;add
              captions&rdquo;, or &ldquo;make it feel faster&rdquo;.
            </p>
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="space-y-1.5">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-xl rounded-br-sm bg-[#4a8fd8]/20 border border-[#4a8fd8]/30 px-3.5 py-2 text-white">
                {t.message}
              </div>
            </div>
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-xl rounded-bl-sm bg-white/[0.06] border border-white/10 px-3.5 py-2 text-white/80">
                <p className="whitespace-pre-wrap">{t.reply}</p>
                {t.changes.length > 0 && (
                  <p className="mt-1.5 text-[11px] font-mono text-[#4a8fd8]/80">
                    edited: {[...new Set(t.changes.map((c) => c.file))].join(", ")}
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="rounded-xl rounded-bl-sm bg-white/[0.06] border border-white/10 px-3.5 py-2.5">
              <Loader2 className="w-4 h-4 animate-spin text-[#4a8fd8]" />
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

      <form onSubmit={send} className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Tell the agent what to change…"
          disabled={sending}
          className="flex-1 bg-black/60 border border-white/20 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#4a8fd8] transition-colors disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || !message.trim()}
          className="bg-[#4a8fd8] text-black font-extrabold text-sm px-5 rounded-xl hover:bg-[#6aa7f0] disabled:opacity-40 transition-colors flex items-center gap-2"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
    </div>
  );
}
