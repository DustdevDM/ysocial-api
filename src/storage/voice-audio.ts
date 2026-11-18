import ffmpeg from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError } from "../auth/provider.ts";

export const voiceMinSeconds = 2;
export const voiceMaxSeconds = 120;
export const voiceUploadLimit = 8 * 1024 * 1024;
const run = promisify(execFile);

function waveformPeaks(pcm: Buffer) {
  const count = 48;
  const sampleCount = pcm.length / 2;
  const levels = Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * sampleCount / count);
    const end = Math.floor((index + 1) * sampleCount / count);
    let energy = 0;
    for (let sample = start; sample < end; sample++) {
      const value = pcm.readInt16LE(sample * 2) / 32768;
      energy += value * value;
    }
    return Math.sqrt(energy / Math.max(1, end - start));
  });
  const peak = Math.max(0.01, ...levels);
  return levels.map((level) => Math.round(100 * Math.pow(level / peak, 0.65)));
}

export async function normalizeVoice(input: Buffer) {
  if (!input.length || input.length > voiceUploadLimit)
    throw new AuthError(400, "invalid_voice");
  if (typeof ffmpeg !== "string")
    throw new AuthError(503, "voice_processing_unavailable");
  const directory = await mkdtemp(join(tmpdir(), "ysocial-voice-"));
  try {
    const source = join(directory, "input");
    const pcm = join(directory, "audio.pcm");
    const output = join(directory, "voice.m4a");
    await writeFile(source, input);
    // Decode samples instead of trusting a client-supplied duration or container metadata.
    // The extra second detects overlong recordings without decoding an unbounded input.
    await run(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "matroska,webm,ogg,mov,mp4,m4a,3gp,3g2,mj2,wav",
        "-threads",
        "1",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        "121",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "s16le",
        pcm,
      ],
      { timeout: 30000, maxBuffer: 65536 },
    );
    const samples = await readFile(pcm);
    const duration = samples.length / (48000 * 2);
    if (duration < voiceMinSeconds) throw new AuthError(400, "voice_too_short");
    if (duration > voiceMaxSeconds) throw new AuthError(400, "voice_too_long");
    await run(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-threads",
        "1",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-i",
        pcm,
        "-af",
        "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        output,
      ],
      { timeout: 30000, maxBuffer: 65536 },
    );
    return {
      body: await readFile(output),
      durationMs: Math.round(duration * 1000),
      waveform: waveformPeaks(samples),
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || ("killed" in error && error.killed === true)))
      throw new AuthError(503, "voice_processing_unavailable");
    throw new AuthError(400, "invalid_voice");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
