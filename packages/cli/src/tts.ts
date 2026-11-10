import { tts } from "@editnce/media";

/** `editnce tts` — text → audio file (MV9). */
export async function ttsCmd(opts: {
  text: string;
  out: string;
  voice?: string;
  provider?: "say" | "edge" | "kokoro";
}) {
  return tts({ text: opts.text, out: opts.out, voice: opts.voice, provider: opts.provider });
}
