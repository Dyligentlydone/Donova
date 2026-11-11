import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Studio rebrand — strip upstream branding from the installed hyperframes
 * Studio bundle on every `donova studio` launch. The UI is compiled React JSX
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

// __DONOVA_LOGO__ / __DONOVA_MARK__ are substituted at patch time with data
// URIs built from assets/donova-dots.png + assets/donova-d.png (committed
// brand assets — dotted wordmark + cropped "d" glyph for the favicon).
const PATCHER = `<script>
// donova-rebrand
(function(){
  var LOGO='__DONOVA_LOGO__';
  var REMOVE_SEL = 'button,[role="menuitem"],a,[role="button"],[aria-label]';
  var REMOVE_TEXT = ['open in desktop app','install the desktop app','finish installing','comment on this storyboard in the desktop app','edit this video in the desktop app'];
  var REMOVE_LABEL = ['get the desktop app'];
  var WORDMARK = 'svg[aria-label="Hyperframes"]';
  var SKIP = {SCRIPT:1,STYLE:1,CODE:1,PRE:1,NOSCRIPT:1};
  function swap(svg){
    var s;
    if (LOGO) {
      s = document.createElement('img');
      s.src = LOGO; s.alt = 'donova';
      s.setAttribute('style','height:22px;width:auto;display:inline-flex;align-items:center');
    } else {
      s = document.createElement('span');
      s.textContent = 'donova';
      s.setAttribute('style','font:800 22px/1 system-ui,-apple-system,sans-serif;letter-spacing:-0.03em;color:currentColor;display:inline-flex;align-items:center;height:28px');
    }
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
    var note=document.createElement('input');
    note.placeholder='describe the edit — e.g. "zoom in on this"';
    note.setAttribute('style','width:220px;padding:4px 10px;border-radius:6px;border:1px solid #5df0a055;background:#0009;color:#e8ecf1;font:12px system-ui;outline:none');
    note.addEventListener('keydown',function(e){
      e.stopPropagation();
      if(e.key==='Enter'){e.preventDefault();submit(ifr);}
      if(e.key==='Escape'){e.preventDefault();note.blur();}
    });
    bar.appendChild(note);
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
    function esc(e){if(e.key==='Escape'&&document.activeElement&&document.activeElement.tagName!=='INPUT')close();}
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
    var ni=document.querySelector('#'+OV_ID+' input');
    var note=ni&&ni.value.trim()?ni.value.trim():'see drawing';
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
      .then(function(j){
        if(!j.ok){toast('save failed: '+(j.error||'?'));return;}
        closeAll();
        if(window.__fcChat){window.__fcChat.send(note,j.file);}
        else toast('saved '+j.file+' — tell your agent');
      })
      .catch(function(){toast('sidecar not running — restart donova studio')});
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

/**
 * Agent chat — collapsible panel wired to the sidecar's /agent/* bridge.
 * Agent picker dropdown lists detected CLIs (claude/codex/gemini/opencode/
 * aider) plus any configured OpenAI-compatible endpoint; selection persists
 * to donova.json. No bridge → file-drop annotations still work.
 * Exposes window.__fcChat for the annotate overlay's "Send to agent" path.
 */
const CHAT = `<script>
// donova-rebrand-chat-v1
(function(){
  var PID='fc-chat',TID='fc-chat-pill',port=(+location.port||80)+1000,base='http://127.0.0.1:'+port;
  var es=null,agent=null,agentList=[],LOGO='__DONOVA_LOGO__';
  function el(t,css,txt){var e=document.createElement(t);e.setAttribute('style',css);if(txt!=null)e.textContent=txt;return e;}
  function msgs(){return document.getElementById('fc-chat-msgs');}
  function scroll(){var m=msgs();if(m)m.scrollTop=m.scrollHeight;}
  function bubble(txt,mine){
    var m=msgs();if(!m)return null;
    var b=el('div','max-width:88%;margin:4px 0;padding:7px 10px;border-radius:9px;font:12px/1.45 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word;'+(mine?'align-self:flex-end;background:#5df0a022;border:1px solid #5df0a055;color:#c9f7dd':'align-self:flex-start;background:#ffffff10;border:1px solid #ffffff22;color:#e8ecf1'));
    b.textContent=txt;m.appendChild(b);scroll();return b;
  }
  function sys(txt){var m=msgs();if(!m)return;var b=el('div','font:10px system-ui,sans-serif;color:#8892a0;margin:4px 0;text-align:center');b.textContent=txt;m.appendChild(b);scroll();}
  function status(txt){var s=document.getElementById('fc-chat-status');if(s)s.textContent=txt;}
  function thumb(file){
    var i=document.createElement('img');i.src=base+'/file?p='+encodeURIComponent(file.replace(/\\.json$/,'.png'));
    i.setAttribute('style','display:block;max-width:100%;border-radius:6px;margin-top:6px;border:1px solid #ffffff22');
    return i;
  }
  function build(){
    if(document.getElementById(PID))return;
    var p=document.createElement('div');p.id=PID;
    p.setAttribute('style','position:fixed;right:20px;bottom:64px;width:340px;height:400px;z-index:2147483000;background:#0b0e14f2;border:1px solid #ffffff22;border-radius:12px;display:none;flex-direction:column;overflow:hidden;font:12px system-ui,sans-serif;color:#e8ecf1');
    var hd=el('div','display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #ffffff14;font:700 12px system-ui,sans-serif');
    var sel=document.createElement('select');sel.id='fc-agent-sel';
    sel.setAttribute('style','flex:1;min-width:0;background:#0009;color:#e8ecf1;border:1px solid #ffffff22;border-radius:6px;padding:3px 6px;font:11px system-ui,sans-serif;outline:none;cursor:pointer');
    sel.addEventListener('change',function(){onPick(sel.value)});
    sel.addEventListener('click',function(e){e.stopPropagation()});
    hd.appendChild(sel);
    var st=el('span','font:10px system-ui,sans-serif;color:#8892a0');st.id='fc-chat-status';st.textContent='…';hd.appendChild(st);
    var x=el('button','background:none;border:none;color:#8892a0;cursor:pointer;font:14px system-ui,sans-serif','×');
    x.onclick=function(){p.style.display='none';};
    hd.appendChild(x);p.appendChild(hd);
    var su=el('div','display:none;padding:8px 10px;border-bottom:1px solid #ffffff14;flex-direction:column;gap:6px');su.id='fc-agent-setup';p.appendChild(su);
    var m=el('div','flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column');m.id='fc-chat-msgs';p.appendChild(m);
    var row=el('div','display:flex;gap:6px;padding:8px;border-top:1px solid #ffffff14');
    var inp=document.createElement('input');inp.id='fc-chat-in';
    inp.placeholder='tell the agent what to change…';
    inp.setAttribute('style','flex:1;padding:6px 10px;border-radius:7px;border:1px solid #ffffff22;background:#0009;color:#e8ecf1;font:12px system-ui,sans-serif;outline:none');
    inp.addEventListener('keydown',function(e){e.stopPropagation();if(e.key==='Enter'){e.preventDefault();go(inp.value);inp.value='';}});
    var sb=el('button','padding:6px 12px;border-radius:7px;border:none;background:#5df0a0;color:#0b0e14;font:700 12px system-ui,sans-serif;cursor:pointer','send');
    sb.onclick=function(){go(inp.value);inp.value='';};
    row.appendChild(inp);row.appendChild(sb);p.appendChild(row);
    document.body.appendChild(p);
  }
  function open(){build();document.getElementById(PID).style.display='flex';health();}
  function health(cb){
    fetch(base+'/agent/list').then(function(r){return r.json()}).then(function(j){
      agentList=j.agents||[];
      var sel=document.getElementById('fc-agent-sel'),found=null;
      if(sel){sel.innerHTML='';agentList.forEach(function(a){
        var o=document.createElement('option');o.value=a.name;
        o.textContent=a.label+(a.detected?'':(a.kind==='api'?' — needs setup':' — not installed'));
        if(a.active){o.selected=true;found=a;}
        sel.appendChild(o);
      });
      if(!sel.options.length){var o=document.createElement('option');o.textContent='no agents found';sel.appendChild(o);}}
      agent=found?found.name:null;
      status(found?'ready':'no agent');
      cb&&cb();
    }).catch(function(){status('sidecar down');});
  }
  function findAgent(name){for(var i=0;i<agentList.length;i++)if(agentList[i].name===name)return agentList[i];return null;}
  function onPick(name){
    var a=findAgent(name);
    if(a&&a.kind==='api'&&!a.detected){showSetup(a);return;}
    hideSetup();
    if(a&&a.kind==='cli'&&!a.detected&&a.install)sys(name+' not installed — run: '+a.install);
    pick(name);
  }
  function pick(name){
    status('switching…');
    fetch(base+'/agent/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name})})
      .then(function(r){return r.json()}).then(function(j){
        agent=j.agent;status(j.agent?('agent: '+j.agent):'no agent');
        if(j.agent)sys('agent → '+j.agent+(j.cmd?(' ('+j.cmd.slice(0,40)+(j.cmd.length>40?'…':'')+')'):''));
        else sys('no agent — set "agent" in donova.json or FC_AGENT');
      }).catch(function(){status('sidecar down')});
  }
  function hideSetup(){var s=document.getElementById('fc-agent-setup');if(s)s.style.display='none';}
  function showSetup(a){
    var su=document.getElementById('fc-agent-setup');if(!su)return;
    su.innerHTML='';su.style.display='flex';
    su.appendChild(el('div','font:600 11px system-ui,sans-serif;color:#5df0a0','set up '+a.label));
    function field(ph,secret){
      var i=document.createElement('input');i.placeholder=ph;
      if(secret)i.type='password';
      i.setAttribute('style','padding:5px 9px;border-radius:6px;border:1px solid #ffffff22;background:#0009;color:#e8ecf1;font:11px system-ui,sans-serif;outline:none;width:100%;box-sizing:border-box');
      i.addEventListener('keydown',function(e){e.stopPropagation()});
      su.appendChild(i);return i;
    }
    var keyIn=a.needsKey?field('API key',true):null;
    var modIn=a.needsModel?field('model (e.g. gpt-5, llama3.2)'):null;
    var urlIn=a.needsUrl?field('endpoint URL (…/v1/chat/completions)'):null;
    var row=el('div','display:flex;gap:6px;justify-content:flex-end');
    var cancel=el('button','padding:4px 10px;border-radius:6px;border:1px solid #ffffff22;background:none;color:#8892a0;font:11px system-ui,sans-serif;cursor:pointer','cancel');
    cancel.onclick=function(){hideSetup();health();};
    var save=el('button','padding:4px 12px;border-radius:6px;border:none;background:#5df0a0;color:#0b0e14;font:700 11px system-ui,sans-serif;cursor:pointer','save & use');
    save.onclick=function(){
      var body={name:a.name};
      if(keyIn&&keyIn.value)body.key=keyIn.value;
      if(modIn&&modIn.value)body.model=modIn.value;
      if(urlIn&&urlIn.value)body.url=urlIn.value;
      status('saving…');
      fetch(base+'/agent/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json()}).then(function(j){
          if(j.ok&&j.configured){hideSetup();sys('saved — '+a.label+' ready');pick(a.name);}
          else{sys(j.ok?'saved, but still incomplete — fill every field':('error: '+j.error));health();}
        }).catch(function(){status('sidecar down')});
    };
    row.appendChild(cancel);row.appendChild(save);su.appendChild(row);
  }
  function go(msg,annotation){
    if(!msg)return;
    open();
    var b=bubble(msg,true);
    if(annotation&&b)b.appendChild(thumb(annotation));
    if(agent===null){health(function(){send(msg,annotation)});return;}
    send(msg,annotation);
  }
  function send(msg,annotation){
    fetch(base+'/agent/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:msg,annotation:annotation||null})})
      .then(function(r){return r.json()})
      .then(function(j){
        if(!j.ok){sys(j.error==='no-agent'?'no agent — pick one in the dropdown or set "agent" in donova.json / FC_AGENT':('error: '+j.error));return;}
        sys('running via '+(j.name||j.cmd)+(j.edits===false?' (reply only — cannot edit files)':'')+' …');
        var out=bubble('',false);
        if(es)es.close();
        es=new EventSource(base+'/agent/jobs/'+j.jobId+'/stream');
        es.onmessage=function(e){try{out.textContent+=JSON.parse(e.data)}catch(x){out.textContent+=e.data}scroll();};
        es.addEventListener('done',function(){es.close();es=null;sys('done');});
        es.onerror=function(){if(es){es.close();es=null;}sys('stream ended');};
      }).catch(function(){sys('sidecar not reachable — restart donova studio')});
  }
  function mount(){
    if(!document.body)return;
    if(!document.getElementById(TID)){
      var t=el('button','position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:8px 14px;border-radius:8px;border:1px solid #5df0a055;background:#0b0e14e6;color:#5df0a0;font:600 13px system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:6px','agent');
      t.id=TID;t.title='chat with the agent';
      if(LOGO){var li=document.createElement('img');li.src=LOGO;li.alt='';li.setAttribute('style','height:12px;width:auto');t.insertBefore(li,t.firstChild);}
      t.onclick=function(){open()};
      document.body.appendChild(t);
    }
  }
  window.__fcChat={send:function(msg,ann){go(msg,ann||null)},open:open};
  new MutationObserver(mount).observe(document.documentElement,{childList:true,subtree:true});
  mount();health();
})();
</script>`;

// "auto donova" toggle — pill pinned in the top header, immediately left of
// the Export button. React owns that header so we never inject inside it —
// we measure Export's rect and pin ourselves beside it (re-measured on a
// timer + resize). Reads/flips the sidecar's /auto route, which drives the
// raw-footage watcher daemon.
const AUTO = `<script>
// donova-rebrand-auto-v2
(function(){
  var ID='fc-auto-pill',port=(+location.port||80)+1000,base='http://127.0.0.1:'+port;
  var st={enabled:false,running:false,down:false};
  function exportBtn(){
    var bs=document.querySelectorAll('button');
    for(var i=0;i<bs.length;i++){
      var t=(bs[i].textContent||'').trim();
      if(t==='Export'||t==='Rendering…'||t==='Rendering...')return bs[i];
    }
    return null;
  }
  function place(){
    var p=document.getElementById(ID);if(!p)return;
    var b=exportBtn();
    if(b){
      var r=b.getBoundingClientRect();
      p.style.top=(r.top+(r.height-p.offsetHeight)/2)+'px';
      p.style.right=(innerWidth-r.left+8)+'px';
      p.style.bottom='auto';
    }else{
      p.style.top='10px';p.style.right='20px';p.style.bottom='auto';
    }
  }
  function pill(){
    var p=document.getElementById(ID);
    if(!p){
      p=document.createElement('button');p.id=ID;
      p.setAttribute('style','position:fixed;top:10px;right:20px;z-index:2147483000;padding:6px 12px;border-radius:8px;border:1px solid #ffffff22;background:#0b0e14e6;color:#9aa3b2;font:600 12px system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:7px');
      p.title='auto donova — drop a clip in "02 Projects/raw footage", it gets edited to your style and lands in "donova videos"';
      p.onclick=function(){
        p.disabled=true;
        fetch(base+'/auto',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:!st.enabled})})
          .then(function(r){return r.json()})
          .then(function(j){p.disabled=false;if(!j.ok){toast(j.error||'auto failed');return;}st.enabled=!!j.enabled;st.running=!!j.running;paint();toast(st.enabled?'auto on — drop a clip in raw footage':'auto off');})
          .catch(function(){p.disabled=false;toast('auto: sidecar unreachable');});
      };
      document.body.appendChild(p);
    }
    return p;
  }
  function paint(){
    var p=document.getElementById(ID);if(!p)return;
    var dot=st.enabled?(st.running?'#5df0a0':'#e9cf6b'):'#ffffff33';
    p.innerHTML='<span style="width:7px;height:7px;border-radius:50%;background:'+dot+';display:inline-block"></span>auto '+(st.enabled?'on':'off');
    p.style.color=st.enabled?'#5df0a0':'#9aa3b2';
    p.style.borderColor=st.enabled?'#5df0a055':'#ffffff22';
    p.style.opacity=st.down?'0.4':'1';
  }
  function toast(m){
    var t=document.createElement('div');t.textContent=m;
    t.setAttribute('style','position:fixed;top:52px;right:20px;z-index:2147483002;background:#0b0e14f2;color:#e8ecf1;border:1px solid #5df0a055;border-radius:8px;padding:8px 14px;font:12px system-ui');
    document.body.appendChild(t);setTimeout(function(){t.remove()},3600);
  }
  function tick(){
    fetch(base+'/auto').then(function(r){return r.json()})
      .then(function(j){st.enabled=!!j.enabled;st.running=!!j.running;st.down=false;paint();})
      .catch(function(){st.down=true;paint();});
  }
  new MutationObserver(function(){pill();place();}).observe(document.documentElement,{childList:true,subtree:true});
  addEventListener('resize',place);
  setInterval(place,2000);setInterval(tick,10000);
  pill();paint();place();tick();
})();
</script>`;

// Strips previously injected payloads regardless of which branding era wrote
// them (donova/editnce/framecraft all use the "<word>-rebrand" marker).
const OLD_SCRIPT_RE = /<script>\s*\/\/ \w+-rebrand[^\n]*[\s\S]*?<\/script>/g;

// Marker hashes the substituted payloads so ANY change — script text or the
// embedded logo — re-patches the bundle.
function markerFor(payloads: string): string {
  return `donova-rebrand-${createHash("sha1").update(payloads).digest("hex").slice(0, 10)}`;
}

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

  // Brand assets: dotted wordmark + cropped "d" glyph, committed under
  // packages/cli/assets and shipped in the published tarball.
  const readAsset = (name: string): string => {
    try {
      return readFileSync(new URL(`../assets/${name}`, import.meta.url)).toString("base64");
    } catch {
      return "";
    }
  };
  const logoUri = readAsset("donova-dots.png");
  const markUri = readAsset("donova-d.png");
  const patcher = PATCHER.replaceAll("__DONOVA_LOGO__", logoUri ? `data:image/png;base64,${logoUri}` : "");
  const chat = CHAT.replaceAll("__DONOVA_LOGO__", logoUri ? `data:image/png;base64,${logoUri}` : "");
  const payloads = `${patcher}${ANNOTATE}${chat}${AUTO}`;
  const marker = markerFor(payloads);

  const indexPath = join(dir, "index.html");
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    if (!html.includes(marker)) {
      const branded = html
        .replace(OLD_SCRIPT_RE, "")
        .replace(/<!--\s*\w+-rebrand-[0-9a-f]+\s*-->/g, "")
        .replace(/<title>[^<]*<\/title>/, "<title>Donova Studio</title>")
        .replace("</body>", `${patcher}\n${ANNOTATE}\n${chat}\n${AUTO}\n<!-- ${marker} -->\n</body>`);
      writeFileSync(indexPath, branded);
    }
  }

  if (markUri) {
    const faviconPath = join(dir, "favicon.svg");
    if (existsSync(faviconPath)) {
      writeFileSync(
        faviconPath,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b0e14"/><image href="data:image/png;base64,${markUri}" x="8" y="8" width="48" height="48"/></svg>\n`,
      );
    }
  }
  return true;
}
