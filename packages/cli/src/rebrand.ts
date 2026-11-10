import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

const DONOVA_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0e14"/><text x="16" y="22.5" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="19" font-weight="800" fill="#e8ecf1">d</text></svg>`;

const PATCHER = `<script>
// donova-rebrand
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

/**
 * Frame annotation ("draw on the frame, tell the agent") — fixed-position
 * Annotate pill + a canvas overlay that tracks the composition rect inside
 * the preview iframe. Marks are stored as normalized comp coords, then the
 * base video frame + strokes are composited to a PNG and POSTed to the
 * fc-annotate sidecar (studioPort + 1000), which writes annotations/*.json
 * + *.png into the project for the agent. Contract: plan/19-ANNOTATE.md.
 */
const ANNOTATE = `<script>
// donova-rebrand-annotate-v1
(function(){
  var BTN_ID='fc-annotate-btn', OV_ID='fc-annotate-ov';
  var marks=[], cur=null, tool='pen', color='#5df0a0', drawing=false;
  // the comp lives in a same-origin iframe inside <hyperframes-player>'s
  // shadow root; falls back to any same-origin iframe with a [data-width] root.
  function frame(){
    var hp=document.querySelector('hyperframes-player');
    var ifr=hp&&hp.shadowRoot?hp.shadowRoot.querySelector('iframe'):document.querySelector('iframe');
    try{if(ifr&&ifr.contentDocument&&ifr.contentDocument.querySelector('[data-width]'))return ifr;}catch(e){}
    return null;
  }
  // the preview iframe renders the comp at NATIVE resolution (innerWidth =
  // data-width) and is transform-scaled to fit. The drawable box is the
  // iframe's displayed rect; comp-normalized coords go through the comp rect
  // inside the iframe's own (native-res) coordinate space.
  function ovRect(ifr){
    var fr=ifr.getBoundingClientRect();
    var cr=ifr.contentDocument.querySelector('[data-width]').getBoundingClientRect();
    var w=ifr.contentWindow;
    return {x:fr.left,y:fr.top,w:fr.width,h:fr.height,cl:cr.left,ct:cr.top,cw:cr.width,ch:cr.height,iw:w.innerWidth,ih:w.innerHeight};
  }
  function toCompPt(r,e){
    var nx=(e.clientX-r.x)/r.w,ny=(e.clientY-r.y)/r.h;
    return {x:(nx*r.iw-r.cl)/r.cw,y:(ny*r.ih-r.ct)/r.ch};
  }
  function toPage(r,p){
    return {x:r.x+((p.x*r.cw+r.cl)/r.iw)*r.w,y:r.y+((p.y*r.ch+r.ct)/r.ih)*r.h};
  }
  function mkBtn(){
    if(document.getElementById(BTN_ID))return null;
    // first-class dashboard tool: clone the Catalog tab so the Annotate tab
    // inherits exact Dockview styling, insert right after it.
    var tabs=document.querySelectorAll('.dv-tabs-container .dv-tab');
    for(var i=0;i<tabs.length;i++){
      if((tabs[i].textContent||'').trim()==='Catalog'){
        var b=tabs[i].cloneNode(true);
        b.id=BTN_ID;
        b.removeAttribute('aria-selected');
        b.removeAttribute('aria-controls');
        b.removeAttribute('data-testid');
        b.classList.remove('dv-active-tab');
        if(b.className.indexOf('dv-inactive-tab')<0)b.classList.add('dv-inactive-tab');
        var tn=b,guard=0;
        while(tn.children.length&&guard++<6){
          var down=false;
          for(var j=0;j<tn.children.length;j++){
            if((tn.children[j].textContent||'').trim()==='Catalog'){tn=tn.children[j];down=true;break;}
          }
          if(!down)break;
        }
        tn.textContent='Annotate';
        b.style.cursor='pointer';
        b.title='Draw on the frame, tell the agent what to do';
        // Dockview treats tab clicks as panel activation — our clone has no
        // panel, so their handler re-renders the strip and wipes the node.
        // Swallow pointer events in capture phase before they ever see it.
        var eat=function(e){e.stopImmediatePropagation();e.preventDefault();};
        b.addEventListener('pointerdown',eat,true);
        b.addEventListener('mousedown',eat,true);
        b.addEventListener('click',function(e){eat(e);toggle();},true);
        tabs[i].parentElement.insertBefore(b,tabs[i].nextSibling);
        return b;
      }
    }
    var f=document.createElement('button');f.id=BTN_ID;
    f.textContent='Annotate';
    f.title='Draw on the frame, tell the agent what to do';
    f.dataset.fallback='1';
    f.setAttribute('style','position:fixed;bottom:20px;right:20px;z-index:2147483000;padding:8px 14px;border-radius:8px;border:1px solid #5df0a055;background:#0b0e14e6;color:#5df0a0;font:600 13px system-ui;cursor:pointer');
    f.addEventListener('pointerdown',function(e){e.stopImmediatePropagation();e.preventDefault();},true);
    f.addEventListener('click',function(e){e.stopImmediatePropagation();e.preventDefault();toggle();},true);
    document.body.appendChild(f);
    return f;
  }
  function toggle(){document.getElementById(OV_ID)?closeAll():open();}
  function closeAll(){var o=document.getElementById(OV_ID);if(o)o.__close&&o.__close();}
  // upgrade the fallback pill to a real tab once the Catalog tab strip mounts
  function mount(){
    if(!document.body)return;
    var cur=document.getElementById(BTN_ID);
    if(cur&&!cur.dataset.fallback)return;
    var tabs=document.querySelectorAll('.dv-tabs-container .dv-tab'),hasCat=false;
    for(var i=0;i<tabs.length;i++)if((tabs[i].textContent||'').trim()==='Catalog'){hasCat=true;break;}
    if(cur&&hasCat){cur.remove();cur=null;}
    if(!cur&&(hasCat||!tabs.length))mkBtn();
  }
  function open(){
    try{openInner()}catch(err){toast('annotate error: '+err);}
  }
  function openInner(){
    var ifr=frame(); if(!ifr){toast('no preview found');return;}
    if(document.getElementById(OV_ID))return;
    var r=ovRect(ifr);
    var ov=document.createElement('div');ov.id=OV_ID;
    // scope to the comp box only — full-viewport canvas sat above the
    // dashboard's own chrome (Annotate tab, panels) and swallowed its clicks.
    ov.setAttribute('style','position:fixed;left:'+r.x+'px;top:'+r.y+'px;width:'+r.w+'px;height:'+r.h+'px;z-index:2147483001');
    var cv=document.createElement('canvas');
    cv.width=r.w*devicePixelRatio;cv.height=r.h*devicePixelRatio;
    cv.setAttribute('style','position:absolute;inset:0;width:100%;height:100%');
    var ctx=cv.getContext('2d');ctx.scale(devicePixelRatio,devicePixelRatio);
    ctx.translate(-r.x,-r.y);
    var bar=document.createElement('div');
    bar.setAttribute('style','position:absolute;top:-44px;left:0;display:flex;gap:6px;align-items:center;background:#0b0e14f2;border:1px solid #ffffff22;border-radius:10px;padding:6px 10px;font:12px system-ui;color:#e8ecf1');
    var tools=['pen','circle','arrow','rect'];
    var tb={};
    tools.forEach(function(t){
      var bt=document.createElement('button');bt.textContent=t;tb[t]=bt;
      bt.setAttribute('style','padding:4px 10px;border-radius:6px;border:1px solid #ffffff22;background:transparent;color:#e8ecf1;cursor:pointer;font:600 12px system-ui');
      bt.onclick=function(){tool=t;paint();};
      bar.appendChild(bt);
    });
    var cols=['#5df0a0','#d7684d','#ffffff','#ffd166'];
    cols.forEach(function(c){
      var sw=document.createElement('button');
      sw.setAttribute('style','width:18px;height:18px;border-radius:50%;border:2px solid '+(c===color?'#fff':'transparent')+';background:'+c+';cursor:pointer');
      sw.onclick=function(){color=c;Array.prototype.forEach.call(bar.querySelectorAll('button[style*="border-radius:50%"]'),function(s){s.style.border='2px solid transparent'});sw.style.border='2px solid #fff';};
      bar.appendChild(sw);
    });
    function pill(label,fn){
      var p=document.createElement('button');p.textContent=label;
      p.setAttribute('style','padding:4px 10px;border-radius:6px;border:1px solid #ffffff22;background:transparent;color:#e8ecf1;cursor:pointer;font:12px system-ui');
      p.onclick=fn;bar.appendChild(p);return p;
    }
    pill('undo',function(){marks.pop();paint();});
    pill('clear',function(){marks=[];paint();});
    var send=document.createElement('button');send.textContent='Send to agent';
    send.setAttribute('style','padding:4px 12px;border-radius:6px;border:none;background:#5df0a0;color:#0b0e14;cursor:pointer;font:700 12px system-ui');
    send.onclick=function(){submit(ifr);};
    bar.appendChild(send);
    pill('esc',close);
    ov.appendChild(cv);ov.appendChild(bar);document.body.appendChild(ov);
    var ab=document.getElementById(BTN_ID);
    if(ab){ab.classList.remove('dv-inactive-tab');ab.classList.add('dv-active-tab');}
    function toComp(e){return toCompPt(r,e);}
    cv.addEventListener('pointerdown',function(e){drawing=true;var p=toComp(e);cur={tool:tool,color:color,pts:[p],to:p};cv.setPointerCapture(e.pointerId);});
    cv.addEventListener('pointermove',function(e){if(!drawing)return;var p=toComp(e);if(cur.tool==='pen')cur.pts.push(p);else cur.to=p;paint();});
    cv.addEventListener('pointerup',function(){if(!drawing)return;drawing=false;marks.push(cur);cur=null;paint();});
    addEventListener('keydown',esc);
    function esc(e){if(e.key==='Escape')close();}
    window.__fcAnnotatePaint=paint;
    function paint(){
      ctx.clearRect(r.x,r.y,r.w,r.h);
      ctx.fillStyle='rgba(0,0,0,0.25)';ctx.fillRect(r.x,r.y,r.w,r.h);
      var all=marks.slice();if(cur)all.push(cur);
      all.forEach(function(m){
        ctx.strokeStyle=m.color;ctx.lineWidth=4;ctx.lineCap='round';ctx.lineJoin='round';
        var ax=function(p){return toPage(r,p).x},ay=function(p){return toPage(r,p).y};
        if(m.tool==='pen'){
          if(m.pts.length<2)return;
          ctx.beginPath();ctx.moveTo(ax(m.pts[0]),ay(m.pts[0]));
          for(var i=1;i<m.pts.length;i++)ctx.lineTo(ax(m.pts[i]),ay(m.pts[i]));
          ctx.stroke();
        }else{
          var a=m.pts[0],b=m.to,pa=toPage(r,a),pb=toPage(r,b);
          if(m.tool==='rect')ctx.strokeRect(pa.x,pa.y,pb.x-pa.x,pb.y-pa.y);
          else if(m.tool==='circle'){ctx.beginPath();ctx.ellipse((pa.x+pb.x)/2,(pa.y+pb.y)/2,Math.abs(pb.x-pa.x)/2,Math.abs(pb.y-pa.y)/2,0,0,7);ctx.stroke();}
          else if(m.tool==='arrow'){
            var ang=Math.atan2(pb.y-pa.y,pb.x-pa.x),hl=16;
            ctx.beginPath();ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);ctx.stroke();
            ctx.beginPath();ctx.moveTo(pb.x,pb.y);ctx.lineTo(pb.x-hl*Math.cos(ang-.5),pb.y-hl*Math.sin(ang-.5));ctx.moveTo(pb.x,pb.y);ctx.lineTo(pb.x-hl*Math.cos(ang+.5),pb.y-hl*Math.sin(ang+.5));ctx.stroke();
          }
        }
      });
      tb[tool].style.background='#5df0a033';
      tools.forEach(function(t){if(t!==tool)tb[t].style.background='transparent';});
    }
    paint();
    function close(){removeEventListener('keydown',esc);ov.remove();marks=[];cur=null;var t=document.getElementById(BTN_ID);if(t){t.classList.remove('dv-active-tab');t.classList.add('dv-inactive-tab');}}
    ov.__close=close;
  }
  function submit(ifr){
    var note=window.prompt('What should the agent do here?');
    if(note==null)return;
    var d=ifr.contentDocument;
    var comp=d.querySelector('[data-width]');
    var t=null;
    try{var p=window.__player;if(p){t=p.currentTime!=null?p.currentTime:(p.time!=null?p.time:null);}}catch(e){}
    var videos=Array.prototype.map.call(d.querySelectorAll('video'),function(v){return {id:v.id||null,start:+(v.getAttribute('data-start')||0),mediaStart:+(v.getAttribute('data-media-start')||0),currentTime:v.currentTime,rect:(function(rc){return{x:rc.left,y:rc.top,w:rc.width,h:rc.height}})(v.getBoundingClientRect())};});
    if(t==null&&videos.length){var v0=videos.reduce(function(a,b){return b.rect.w*b.rect.h>a.rect.w*a.rect.h?b:a});t=v0.start+(v0.currentTime-v0.mediaStart);}
    var png=null;
    try{
      var vids=d.querySelectorAll('video'),bv=null,ba=0;
      for(var i=0;i<vids.length;i++){var rc=vids[i].getBoundingClientRect();if(rc.width*rc.height>ba&&vids[i].videoWidth){ba=rc.width*rc.height;bv=vids[i];}}
      if(bv){
        var c=document.createElement('canvas');
        var sc=Math.min(1,960/bv.videoWidth);
        c.width=bv.videoWidth*sc;c.height=bv.videoHeight*sc;
        var cx2=c.getContext('2d');
        cx2.drawImage(bv,0,0,c.width,c.height);
        var cr2=ifr.contentDocument.querySelector('[data-width]').getBoundingClientRect();
        var vr=bv.getBoundingClientRect();
        var vnx=(vr.left-cr2.left)/cr2.width, vny=(vr.top-cr2.top)/cr2.height;
        var vnw=vr.width/cr2.width, vnh=vr.height/cr2.height;
        var cw=comp?+comp.getAttribute('data-width'):c.width;
        var mx=function(p){return (p.x-vnx)/vnw*bv.videoWidth*sc},my=function(p){return (p.y-vny)/vnh*bv.videoHeight*sc};
        var dx=function(p){return p.x/vnw*bv.videoWidth*sc},dy=function(p){return p.y/vnh*bv.videoHeight*sc};
        marks.forEach(function(m){
          cx2.strokeStyle=m.color;cx2.lineWidth=4*(c.width/cw);cx2.lineCap='round';cx2.lineJoin='round';
          var a=m.pts[0],b=m.to;
          if(m.tool==='pen'&&m.pts.length>1){cx2.beginPath();cx2.moveTo(mx(m.pts[0]),my(m.pts[0]));for(var j=1;j<m.pts.length;j++)cx2.lineTo(mx(m.pts[j]),my(m.pts[j]));cx2.stroke();}
          else if(m.tool==='rect')cx2.strokeRect(mx(a),my(a),dx(b)-dx(a),dy(b)-dy(a));
          else if(m.tool==='circle'){cx2.beginPath();cx2.ellipse((mx(a)+mx(b))/2,(my(a)+my(b))/2,Math.abs(dx(b)-dx(a))/2,Math.abs(dy(b)-dy(a))/2,0,0,7);cx2.stroke();}
          else if(m.tool==='arrow'){cx2.beginPath();cx2.moveTo(mx(a),my(a));cx2.lineTo(mx(b),my(b));cx2.stroke();}
        });
        png=c.toDataURL('image/png');
      }
    }catch(e){}
    var port=(+location.port||80)+1000;
    fetch('http://127.0.0.1:'+port+'/annotate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:t,comp:comp?{w:+comp.getAttribute('data-width'),h:+comp.getAttribute('data-height')}:null,marks:marks.map(function(m){return {type:m.tool,color:m.color,from:m.pts[0],to:m.to,pts:m.pts.length>2?m.pts:undefined}}),note:note,png:png})})
      .then(function(r){return r.json()})
      .then(function(j){toast(j.ok?('saved '+j.file+' — tell your agent'):('save failed: '+(j.error||'?')))})
      .catch(function(){toast('sidecar not running — restart fc studio')});
  }
  function toast(msg){
    var t=document.createElement('div');t.textContent=msg;
    t.setAttribute('style','position:fixed;bottom:64px;right:20px;z-index:2147483002;background:#0b0e14f2;color:#e8ecf1;border:1px solid #5df0a055;border-radius:8px;padding:8px 14px;font:12px system-ui');
    document.body.appendChild(t);setTimeout(function(){t.remove()},4000);
  }
  new MutationObserver(mount).observe(document.documentElement,{childList:true,subtree:true});
  mount();
})();
</script>`;

const OLD_SCRIPT_RE = /<script>\s*\/\/ donova-rebrand[^\n]*[\s\S]*?<\/script>/g;

// Marker hashes the injected payloads so ANY change to PATCHER/ANNOTATE
// re-patches the bundle — a bumped-by-hand version string kept letting stale
// scripts survive across edits.
const MARKER = `donova-rebrand-${createHash("sha1").update(`${PATCHER}${ANNOTATE}`).digest("hex").slice(0, 10)}`;

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
        .replace("</body>", `${PATCHER}\n${ANNOTATE}\n<!-- ${MARKER} -->\n</body>`);
      writeFileSync(indexPath, branded);
    }
  }

  const faviconPath = join(dir, "favicon.svg");
  if (existsSync(faviconPath)) writeFileSync(faviconPath, `${DONOVA_FAVICON}\n`);
  return true;
}
