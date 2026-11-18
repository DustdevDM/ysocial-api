// Deterministic quiet speech-range signal for real encoder and HTTP tests.
export function makeVoiceWav(seconds, sampleRate = 16000) {
  const samples = Math.round(seconds * sampleRate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const time = i / sampleRate;
    const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * time);
    const sound =
      Math.sin(2 * Math.PI * 220 * time) +
      0.5 * Math.sin(2 * Math.PI * 660 * time);
    wav.writeInt16LE(Math.round(900 * envelope * sound), 44 + i * 2);
  }
  return wav;
}
