import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { normalizeVoice } from "../src/storage/voice-audio.ts";
import { makeVoiceWav } from "./fixtures/voice.mjs";

test("voice duration is measured from decoded audio, with inclusive limits", async () => {
  for (const duration of [2, 120]) {
    const result = await normalizeVoice(makeVoiceWav(duration));
    assert.equal(result.durationMs, duration * 1000);
    assert.ok(
      result.body.length < 20000 * duration,
      `compressed size ${result.body.length}`,
    );
    assert.match(result.body.toString("ascii", 4, 12), /ftyp/);
  }
  for (const [duration, code] of [
    [1.99, "voice_too_short"],
    [120.01, "voice_too_long"],
    [125, "voice_too_long"],
  ])
    await assert.rejects(
      normalizeVoice(makeVoiceWav(duration)),
      (error) => error.code === code,
    );
  await assert.rejects(
    normalizeVoice(Buffer.from("invalid audio")),
    (error) => error.code === "invalid_voice",
  );
  await assert.rejects(
    normalizeVoice(Buffer.alloc(8 * 1024 * 1024 + 1)),
    (error) => error.code === "invalid_voice",
  );
});

test("compressed voice decodes to mono 48kHz AAC with audible, unclipped samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-test-"));
  try {
    const { body } = await normalizeVoice(makeVoiceWav(3));
    const path = join(directory, "voice.m4a");
    await writeFile(path, body);
    const run = promisify(execFile);
    const { stderr } = await run(
      ffmpeg,
      ["-hide_banner", "-i", path, "-f", "null", "-"],
      { encoding: "utf8" },
    );
    assert.match(stderr, /Audio: aac.*48000 Hz, mono/);
    const { stdout } = await run(
      ffmpeg,
      ["-v", "error", "-i", path, "-f", "s16le", "-"],
      { encoding: "buffer", maxBuffer: 1000000 },
    );
    let peak = 0,
      squareSum = 0;
    for (let offset = 0; offset < stdout.length; offset += 2) {
      const value = stdout.readInt16LE(offset) / 32768;
      peak = Math.max(peak, Math.abs(value));
      squareSum += value * value;
    }
    const rms = Math.sqrt(squareSum / (stdout.length / 2));
    assert.ok(rms > 0.08 && rms < 0.3, `normalized RMS ${rms}`);
    assert.ok(peak < 0.95, `unclipped peak ${peak}`);
    assert.ok(Math.abs(stdout.length / 96000 - 3) < 0.05);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser WebM/Opus, Ogg/Opus and MP4/AAC recordings normalize successfully", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-formats-"));
  try {
    const path = join(directory, "voice.wav");
    await writeFile(path, makeVoiceWav(3));
    const run = promisify(execFile);
    for (const [format, codec] of [
      ["webm", "libopus"],
      ["ogg", "libopus"],
      ["mp4", "aac"],
    ]) {
      const { stdout } = await run(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          path,
          "-c:a",
          codec,
          "-b:a",
          "64k",
          ...(format === "mp4"
            ? ["-movflags", "frag_keyframe+empty_moov"]
            : []),
          "-f",
          format,
          "-",
        ],
        { encoding: "buffer", maxBuffer: 1000000 },
      );
      const normalized = await normalizeVoice(stdout);
      assert.ok(
        Math.abs(normalized.durationMs - 3000) < 100,
        `${format} duration ${normalized.durationMs}`,
      );
      assert.ok(
        normalized.body.length < 60000,
        `${format} compressed size ${normalized.body.length}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
