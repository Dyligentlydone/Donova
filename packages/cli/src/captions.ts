import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeTranscript } from "@editnce/media";
import type { CutPlan, Transcript, TranscriptWord } from "@editnce/media";
import { CliError, ERR } from "./errors.js";

/**
 * `editnce captions` — generate a caption track into index.html from a
 * transcript + cuts plan (17 §4 / MV4). Writes timed caption elements using
 * the word-captions block's classes (install it first for styles), mapped
 * source→comp through the cut plan.
 */

const ESC = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const POP =
  '{"v":1,"anims":[{"t":0,"dur":0.16,"ease":"back.out(2)","props":{"scale":[0.6,1],"opacity":[0,1]}}]}';

function mapToComp(plan: CutPlan, srcT: number): number | null {
  for (const s of plan.segments) {
    if (srcT >= s.srcStart && srcT <= s.srcEnd) return s.compStart + (srcT - s.srcStart);
  }
  return null;
}

export async function captionsCmd(opts: {
  dir: string;
  transcript: string;
  cuts?: string;
  mode?: "word" | "phrase";
  emphasis?: string[];
  maxPhraseWords?: number;
}): Promise<{ path: string; captions: number; mode: string }> {
  const dir = resolve(opts.dir);
  const transcriptPath = resolve(dir, opts.transcript);
  const transcript: Transcript = normalizeTranscript(JSON.parse(await readFile(transcriptPath, "utf8")));
  const plan: CutPlan | undefined = opts.cuts
    ? (JSON.parse(await readFile(resolve(dir, opts.cuts), "utf8")) as CutPlan)
    : undefined;

  // Word → comp time. Without a plan, comp time == source time.
  const toComp = (srcT: number) => (plan ? mapToComp(plan, srcT) : srcT);
  const emphasis = new Set((opts.emphasis ?? []).map((w) => w.toLowerCase().replace(/[^\w$]/g, "")));

  const words = transcript.words;
  const mode = opts.mode ?? "word";

  // Group words into caption units.
  const units: Array<{ text: string; srcStart: number; srcEnd: number; em: boolean }> = [];
  if (mode === "word") {
    for (const w of words) {
      const em = emphasis.has(w.w.toLowerCase().replace(/[^\w$]/g, ""));
      units.push({ text: w.w, srcStart: w.start, srcEnd: w.end, em });
    }
  } else {
    // Phrase mode: 2–N words, break at punctuation or ≥0.3s gaps.
    const max = opts.maxPhraseWords ?? 4;
    let cur: TranscriptWord[] = [];
    const flush = () => {
      if (!cur.length) return;
      const first = cur[0];
      const last = cur[cur.length - 1];
      const text = cur.map((x) => x.w).join(" ");
      const em = cur.some((x) => emphasis.has(x.w.toLowerCase().replace(/[^\w$]/g, "")));
      if (first && last) units.push({ text, srcStart: first.start, srcEnd: last.end, em });
      cur = [];
    };
    for (const w of words) {
      const prev = cur[cur.length - 1];
      const gap = prev ? w.start - prev.end : 0;
      if (cur.length >= max || (prev && gap > 0.3) || /[.!?…]$/.test(prev?.w ?? "")) flush();
      cur.push(w);
    }
    flush();
  }

  // Root duration caps caption end so clips never overrun the composition.
  const indexPath = join(dir, "index.html");
  const html = await readFile(indexPath, "utf8").catch(() => {
    throw new CliError(ERR.FILE_NOT_FOUND, `no index.html in ${dir}`);
  });
  const rootDur = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? Number.POSITIVE_INFINITY);

  // Build caption elements; skip words that fell in a cut. Each caption holds
  // toward the readability rule (~0.5s + 0.3s/word) but never past the next
  // caption's start, so holds extend into speech gaps without overlapping.
  const compStarts = units.map((u) => toComp(u.srcStart));
  const els: string[] = [];
  for (const [i, u] of units.entries()) {
    const start = compStarts[i];
    if (start == null || start >= rootDur) continue;
    const natural = Math.max(0.12, u.srcEnd - u.srcStart);
    const target = 0.5 + 0.3 * u.text.trim().split(/\s+/).length;
    const nextStart = compStarts.slice(i + 1).find((s) => s != null && s > start) ?? rootDur;
    const dur = Math.min(Math.max(natural, Math.min(target, nextStart - start)), rootDur - start);
    const cls = mode === "word" ? (u.em ? "fc-cap fc-cap-em" : "fc-cap") : "fc-pcap";
    els.push(
      `  <div id="cap-${i}" class="clip" data-start="${start.toFixed(3)}" data-duration="${dur.toFixed(3)}">\n    <span class="${cls}" data-fc-motion='${POP}'>${ESC(u.text)}</span>\n  </div>`,
    );
  }
  if (!els.length) {
    throw new CliError(ERR.INVALID_PROJECT, "no caption words survived the cut plan");
  }

  // Insert before the closing </div> of the root composition (last </div>).
  // Regeneration is idempotent: strip any previously generated block first.
  const BEGIN = "<!-- generated captions";
  const END = "<!-- /generated captions -->";
  const bIdx = html.indexOf(BEGIN);
  const eIdx = html.indexOf(END);
  const stripped = bIdx >= 0 && eIdx > bIdx ? html.slice(0, bIdx) + html.slice(eIdx + END.length) : html;
  const rootClose = stripped.lastIndexOf("</div>");
  if (rootClose < 0) throw new CliError(ERR.INVALID_PROJECT, "index.html has no composition root");
  const block = `\n  ${BEGIN} (${mode}) — regenerate with editnce captions -->\n${els.join("\n")}\n  ${END}\n`;

  // Ensure caption styles exist: inline the word-captions block <style> if absent.
  let out = stripped.slice(0, rootClose) + block + stripped.slice(rootClose);
  if (!out.includes(".fc-cap") && !out.includes(".fc-pcap")) {
    const style =
      "\n<style>\n  .fc-cap { position:absolute; left:50%; bottom:30%; transform:translateX(-50%); font:var(--fc-cap-font,800 64px/1.1 system-ui,sans-serif); color:var(--fc-cap-color,#fff); text-shadow:var(--fc-cap-shadow,0 2px 12px rgba(0,0,0,0.7)); white-space:nowrap; pointer-events:none; }\n  .fc-cap-em { color:var(--fc-cap-accent,#ffd166); }\n  .fc-pcap { position:absolute; left:50%; bottom:12%; transform:translateX(-50%); font:var(--fc-cap-font,700 44px/1.25 system-ui,sans-serif); color:var(--fc-cap-color,#fff); background:var(--fc-cap-bg,rgba(0,0,0,0.55)); padding:.25em .6em; border-radius:.35em; text-align:center; white-space:nowrap; pointer-events:none; }\n</style>";
    out = out.replace("</style>", `</style>${style}`);
    if (!out.includes("</style>")) out = out.replace("</head>", `${style}\n</head>`);
  }
  await writeFile(indexPath, out);
  return { path: indexPath, captions: els.length, mode };
}
