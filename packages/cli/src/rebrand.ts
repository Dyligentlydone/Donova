import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Studio rebrand — swap the upstream wordmark/title/favicon for ours in the
 * installed hyperframes dist bundle. The logo is a compiled-JSX SVG (vector
 * paths, no text), so instead of editing minified JSX we inject a small
 * script into the served index.html that replaces the svg element with a
 * styled "donova" span. Idempotent via a marker; re-run on every launch so a
 * package reinstall gets patched again. Full vendoring (item 3) supersedes.
 */

const MARKER = "donova-rebrand";

const DONOVA_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0e14"/><text x="16" y="22.5" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="19" font-weight="800" fill="#e8ecf1">d</text></svg>`;

const PATCHER = `<script>
// donova-rebrand
(function(){
  function brand(){
    document.querySelectorAll('svg[aria-label="Hyperframes"]').forEach(function(svg){
      var s = document.createElement('span');
      s.textContent = 'donova';
      s.setAttribute('style','font:800 22px/1 system-ui,-apple-system,sans-serif;letter-spacing:-0.03em;color:currentColor;display:inline-flex;align-items:center;height:28px');
      svg.replaceWith(s);
    });
  }
  brand();
  new MutationObserver(brand).observe(document.documentElement,{childList:true,subtree:true});
})();
</script>`;

function studioUiDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("hyperframes/package.json");
    return join(dirname(pkg), "dist", "studio");
  } catch {
    return null;
  }
}

/** Apply the rebrand to the installed studio bundle. Returns true if the bundle was found. */
export function rebrandStudioUi(): boolean {
  const dir = studioUiDir();
  if (!dir) return false;

  const indexPath = join(dir, "index.html");
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    if (!html.includes(MARKER)) {
      const branded = html
        .replace(/<title>[^<]*<\/title>/, "<title>Donova Studio</title>")
        .replace("</body>", `${PATCHER}\n</body>`);
      writeFileSync(indexPath, branded);
    }
  }

  const faviconPath = join(dir, "favicon.svg");
  if (existsSync(faviconPath)) writeFileSync(faviconPath, `${DONOVA_FAVICON}\n`);
  return true;
}
