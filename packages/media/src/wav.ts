import { readFile } from "node:fs/promises";

export interface Wave {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Read a 16kHz mono PCM16 WAV (the shape our ffmpeg prep emits) into float
 * samples. Parses RIFF chunks rather than assuming a fixed 44-byte header —
 * ffmpeg writes LIST/metadata chunks on some inputs.
 */
export async function readWav(path: string): Promise<Wave> {
  const buf = await readFile(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a WAV file: ${path}`);
  }
  let sampleRate = 0;
  let bits = 16;
  let channels = 1;
  let dataOff = -1;
  let dataLen = 0;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.min(size, buf.length - dataOff);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0 || !sampleRate) throw new Error(`WAV has no data chunk: ${path}`);
  const frames = Math.floor(dataLen / ((bits / 8) * channels));
  const samples = new Float32Array(frames);
  if (bits === 16) {
    for (let i = 0; i < frames; i++) {
      samples[i] = buf.readInt16LE(dataOff + i * 2 * channels) / 32768;
    }
  } else if (bits === 32) {
    for (let i = 0; i < frames; i++) {
      samples[i] = buf.readFloatLE(dataOff + i * 4 * channels);
    }
  } else {
    throw new Error(`unsupported WAV bit depth ${bits}: ${path}`);
  }
  return { samples, sampleRate };
}
