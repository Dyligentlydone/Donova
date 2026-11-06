/**
 * <framecraft-player> — embeddable composition player (05).
 * Hosts the composition in an iframe and drives it through __fc.renderSeek.
 * Playback uses a rAF clock for realtime preview; render stays frame-stepped.
 */

export const PLAYER_TAG = "framecraft-player";

export interface PlayerState {
  ready: boolean;
  duration: number;
  playing: boolean;
  time: number;
  width: number;
  height: number;
}

const template = document.createElement("template");
template.innerHTML = `
<style>
  :host { display: block; position: relative; contain: content; }
  iframe { border: 0; width: 100%; height: 100%; display: block; background: #000; }
</style>
<iframe part="frame" allow="autoplay"></iframe>
`;

export class FramecraftPlayer extends HTMLElement {
  static observedAttributes = ["src", "autoplay", "loop", "controls"];
  private iframe: HTMLIFrameElement;
  private duration = 0;
  private playing = false;
  private time = 0;
  private raf = 0;
  private last = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));
    this.iframe = root.querySelector("iframe")!;
  }

  connectedCallback(): void {
    const src = this.getAttribute("src") ?? "index.html";
    if (this.iframe.src !== src && !this.iframe.src.endsWith(src)) this.iframe.src = src;
    this.iframe.addEventListener("load", () => void this.onLoad());
  }

  disconnectedCallback(): void {
    this.pause();
  }

  private async onLoad(): Promise<void> {
    await this.waitReady();
    const doc = this.iframe.contentDocument;
    const root = doc?.querySelector("[data-composition-id]");
    this.duration = Number(root?.getAttribute("data-duration") ?? "1") || 1;
    this.dispatchEvent(new CustomEvent("fc-ready", { detail: this.state }));
    if (this.hasAttribute("autoplay")) void this.play();
  }

  private waitReady(): Promise<void> {
    return new Promise((r) => {
      const i = setInterval(() => {
        const w = this.iframe.contentWindow as unknown as { __playerReady?: boolean } | null;
        if (w?.__playerReady) {
          clearInterval(i);
          r();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(i);
        r();
      }, 15_000);
    });
  }

  private get fc(): { renderSeek: (t: number) => Promise<void> } | undefined {
    return (this.iframe.contentWindow as unknown as { __fc?: { renderSeek: (t: number) => Promise<void> } })?.__fc;
  }

  get state(): PlayerState {
    const w = this.iframe.contentWindow as unknown as { __fc?: { fps: number } } | null;
    return {
      ready: !!(this.iframe.contentWindow as unknown as { __playerReady?: boolean } | null)?.__playerReady,
      duration: this.duration,
      playing: this.playing,
      time: this.time,
      width: this.iframe.clientWidth,
      height: this.iframe.clientHeight,
    };
    void w;
  }

  async seek(t: number): Promise<void> {
    this.time = Math.max(0, Math.min(t, this.duration));
    await this.fc?.renderSeek(this.time);
    this.dispatchEvent(new CustomEvent("fc-seek", { detail: this.state }));
  }

  async play(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    this.last = performance.now();
    const tick = async (now: number): Promise<void> => {
      if (!this.playing) return;
      const dt = (now - this.last) / 1000;
      this.last = now;
      let t = this.time + dt;
      if (t >= this.duration) {
        if (this.hasAttribute("loop")) t = 0;
        else {
          this.playing = false;
          this.dispatchEvent(new CustomEvent("fc-ended", { detail: this.state }));
          return;
        }
      }
      await this.seek(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.dispatchEvent(new CustomEvent("fc-play", { detail: this.state }));
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.dispatchEvent(new CustomEvent("fc-pause", { detail: this.state }));
  }
}

if (!customElements.get(PLAYER_TAG)) {
  customElements.define(PLAYER_TAG, FramecraftPlayer);
}
