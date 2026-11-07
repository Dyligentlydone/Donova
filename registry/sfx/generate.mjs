// Generates the Framecraft SFX library into registry/sfx/<name>/<name>.wav.
// Every sound is synthesized locally with ffmpeg — no external samples, so the
// whole library is unencumbered and redistributable. Re-run: node generate.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const out = (n) => join(import.meta.dirname, n, `${n}.wav`);

// [name, aeval expression, duration s, description]
const SOUNDS = [
  ["pop", "sin(2*PI*(700*t-300*t*t))*exp(-14*t)", 0.25, "short UI pop, card land"],
  ["whoosh", "(random(0)*2-1)*exp(-4*abs(t-0.35))*0.3", 0.7, "noise sweep, transition"],
  ["riser", "sin(2*PI*(200*t+800*t*t))*t*exp(-3*t)", 0.7, "rising pitch, anticipation"],
  ["impact", "sin(2*PI*80*t)*exp(-8*t)+(random(0)*2-1)*exp(-25*t)*0.5", 0.5, "bass hit + snap"],
  ["click", "sin(2*PI*2000*t)*exp(-60*t)", 0.08, "tiny click"],
  ["swish", "(random(0)*2-1)*exp(-8*abs(t-0.15))*0.25", 0.4, "light fabric swish"],
  ["ding", "sin(2*PI*880*t)*exp(-6*t)+0.4*sin(2*PI*1760*t)*exp(-8*t)", 0.6, "bell ding"],
  ["buzz", "(gt(sin(2*PI*110*t),0)*2-1)*exp(-6*t)*0.35", 0.4, "error buzz"],
  ["swoosh-down", "sin(2*PI*(900*t-700*t*t))*exp(-4*t)*0.4", 0.6, "descending swoosh"],
  ["tick", "sin(2*PI*3200*t)*exp(-80*t)", 0.05, "metronome tick"],
  ["chime", "sin(2*PI*660*t)*exp(-5*t)+sin(2*PI*990*max(t-0.12,0))*gt(t,0.12)*exp(-5*(t-0.12))", 0.8, "two-note chime"],
  ["thud", "sin(2*PI*60*t)*exp(-10*t)", 0.4, "low thud"],
  ["air", "(random(0)*2-1)*exp(-2*abs(t-0.5))*0.12", 1.0, "soft airy wash"],
  ["camera-shutter", "sin(2*PI*2400*t)*exp(-90*t)+sin(2*PI*1800*max(t-0.09,0))*gt(t,0.09)*exp(-80*(t-0.09))", 0.25, "photo shutter"],
  ["notification", "sin(2*PI*830*t)*exp(-6*t)*0.5+sin(2*PI*1100*max(t-0.1,0))*gt(t,0.1)*exp(-6*(t-0.1))*0.5", 0.5, "soft two-tone alert"],
];

const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const manifest = { version: 1, license: "Framecraft original (synthesized, free to redistribute)", sounds: [] };

for (const [name, expr, dur, description] of SOUNDS) {
  mkdirSync(join(import.meta.dirname, name), { recursive: true });
  execFileSync(ffmpeg, [
    "-y", "-f", "lavfi", "-i",
    `aevalsrc='${expr}':s=48000:d=${dur}`,
    "-ac", "1", "-c:a", "pcm_s16le", out(name),
  ], { stdio: ["ignore", "ignore", "pipe"] });
  manifest.sounds.push({ name, file: `${name}/${name}.wav`, duration: dur, description });
  console.log(`✓ ${name}`);
}

mkdirSync(import.meta.dirname, { recursive: true });
await import("node:fs").then((fs) =>
  fs.writeFileSync(join(import.meta.dirname, "sfx.json"), JSON.stringify(manifest, null, 2)),
);
console.log(`\n${SOUNDS.length} sounds → registry/sfx/`);
