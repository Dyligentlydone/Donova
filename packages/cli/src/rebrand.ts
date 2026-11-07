import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Studio rebrand — strip upstream branding from the installed hyperframes
 * Studio bundle on every `fc studio` launch. The UI is compiled React JSX
 * (vector-path logo, minified strings), so instead of editing the bundle we
 * inject a DOM patcher into the served index.html that:
 *   - swaps the svg[aria-label="Hyperframes"] wordmark for "donova"
 *   - removes HeyGen surfaces entirely ("Open in desktop app" button and its
 *     menu items, aria-label "Get the desktop app" trigger)
 *   - rewrites remaining "HyperFrames"/"HeyGen" text nodes to "Donova" in
 *     rendered UI (dialogs, toasts, menus — never script/style/code)
 * Each React-added node is checked itself AND its descendants — React mounts
 * controls as direct additions, which a descendants-only scan misses.
 * Idempotent via a versioned marker; re-runs on launch so reinstalls get
 * patched. Kept: Capture, Inspector, Export (local render), Window, agent
 * and gesture slots. Full vendoring (item 3) supersedes.
 */

const MARKER = "donova-rebrand-v3";

const DONOVA_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0e14"/><text x="16" y="22.5" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="19" font-weight="800" fill="#e8ecf1">d</text></svg>`;

const PATCHER = `<script>
// donova-rebrand-v3
(function(){
  var REMOVE_SEL = 'button,[role="menuitem"],a,[role="button"],[aria-label]';
  var REMOVE_TEXT = ['open in desktop app','install the desktop app','finish installing','comment on this storyboard in the desktop app','edit this video in the desktop app'];
  var REMOVE_LABEL = ['get the desktop app'];
  var WORDMARK = 'svg[aria-label="Hyperframes"]';
  var SKIP = {SCRIPT:1,STYLE:1,CODE:1,PRE:1,NOSCRIPT:1};
  function swap(svg){
    var s = document.createElement('span');
    s.textContent = 'donova';
    s.setAttribute('style','font:800 22px/1 system-ui,-apple-system,sans-serif;letter-spacing:-0.03em;color:currentColor;display:inline-flex;align-items:center;height:28px');
    svg.replaceWith(s);
  }
  function drop(el){
    var t = (el.textContent||'').trim().toLowerCase();
    var label = (el.getAttribute('aria-label')||'').toLowerCase();
    if (REMOVE_TEXT.indexOf(t) >= 0 || REMOVE_LABEL.indexOf(label) >= 0) el.remove();
  }
  function texts(n){ n.textContent = n.textContent.replace(/HeyGen/g,'Donova').replace(/heygen/g,'donova').replace(/HyperFrames/g,'Donova').replace(/hyperframes/g,'donova'); }
  function scrub(root){
    var self = root.nodeType === 1 ? root : null;
    if (self && self.matches && self.matches(WORDMARK)) swap(self);
    if (root.querySelectorAll) root.querySelectorAll(WORDMARK).forEach(swap);
    if (self && self.matches && self.matches(REMOVE_SEL)) drop(self);
    if (root.querySelectorAll) root.querySelectorAll(REMOVE_SEL).forEach(drop);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {acceptNode:function(n){
      var p = n.parentElement && n.parentElement.tagName;
      if (p && SKIP[p]) return NodeFilter.FILTER_REJECT;
      return /heygen|hyperframes/i.test(n.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }});
    var n, nodes = [];
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(texts);
  }
  scrub(document.documentElement);
  var pending = false, queued = [];
  new MutationObserver(function(muts){
    muts.forEach(function(m){ m.addedNodes.forEach(function(n){ queued.push(n); }); });
    if (pending) return; pending = true;
    requestAnimationFrame(function(){ pending = false; var q = queued; queued = []; q.forEach(scrub); });
  }).observe(document.documentElement,{childList:true,subtree:true});
})();
</script>`;

const OLD_SCRIPT_RE = /<script>\s*\/\/ donova-rebrand[^\n]*[\s\S]*?<\/script>/;

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
        .replace(OLD_SCRIPT_RE, "")
        .replace(/<title>[^<]*<\/title>/, "<title>Donova Studio</title>")
        .replace("</body>", `${PATCHER}\n</body>`);
      writeFileSync(indexPath, branded);
    }
  }

  const faviconPath = join(dir, "favicon.svg");
  if (existsSync(faviconPath)) writeFileSync(faviconPath, `${DONOVA_FAVICON}\n`);
  return true;
}
