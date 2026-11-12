import * as parse5 from "parse5";

/**
 * Byte-preserving DOM mutations — same splice strategy as the local Studio
 * server: parse5 locates elements, edits are applied as string splices on the
 * ORIGINAL html so untouched regions keep their bytes (undo/diff fidelity).
 */
export async function applyMutation(
  html: string,
  mutations: Array<Record<string, unknown>>,
): Promise<string> {
  const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
  type El = parse5.DefaultTreeAdapterMap["element"];
  const walk = function* (n: unknown): Generator<El> {
    const node = n as {
      tagName?: string;
      childNodes?: unknown[];
      attrs?: Array<{ name: string; value: string }>;
    };
    if (node.tagName) yield node as unknown as El;
    for (const c of node.childNodes ?? []) yield* walk(c);
  };
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const timedEls = [...walk(doc)].filter((e) =>
    e.attrs?.some((a: { name: string; value: string }) => a.name === "data-start"),
  );
  const targetsFor = (m: Record<string, unknown>): El[] =>
    typeof m.domIndex === "number"
      ? timedEls.filter((_e, i) => i === m.domIndex)
      : [...walk(doc)].filter((e) =>
          e.attrs?.some((a: { name: string; value: string }) => `[${a.name}="${a.value}"]` === m.selector),
        );

  for (const m of mutations) {
    if (m.op === "setAttr") {
      for (const el of targetsFor(m)) {
        const loc = el.sourceCodeLocation;
        if (!loc?.startTag) continue;
        const attrName = String(m.attr);
        const value = String(m.value ?? "").replace(/"/g, "&quot;");
        const openTag = html.slice(loc.startTag.startOffset, loc.startTag.endOffset);
        const attrRe = new RegExp(`\\s${attrName}="[^"]*"`);
        const newTag = attrRe.test(openTag)
          ? openTag.replace(attrRe, ` ${attrName}="${value}"`)
          : openTag.replace(/\s*\/?>$/, (tail) => ` ${attrName}="${value}"${tail}`);
        edits.push({ start: loc.startTag.startOffset, end: loc.startTag.endOffset, text: newTag });
      }
    } else if (m.op === "setText") {
      for (const el of targetsFor(m)) {
        const loc = el.sourceCodeLocation;
        if (!loc?.startTag || !loc.endTag) continue;
        edits.push({
          start: loc.startTag.endOffset,
          end: loc.endTag.startOffset,
          text: String(m.value ?? ""),
        });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
