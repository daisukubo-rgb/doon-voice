import { encodeWav, mergeAudioChunks } from "../src/audio-recorder.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const wav = encodeWav(new Float32Array([0, 1, -1]), 16_000);
const ascii = (from: number, to: number) => String.fromCharCode(...wav.slice(from, to));

assert(ascii(0, 4) === "RIFF", "録音はWAVのRIFFヘッダーで渡す");
assert(ascii(8, 12) === "WAVE", "録音はWhisperが読めるWAV形式にする");
assert(new DataView(wav.buffer).getUint32(24, true) === 16_000, "元のサンプルレートをWAVへ保存する");
assert(new DataView(wav.buffer).getInt16(44 + 2, true) === 32_767, "正のPCM値を16bitへ変換する");
assert(new DataView(wav.buffer).getInt16(44 + 4, true) === -32_768, "負のPCM値を16bitへ変換する");

const merged = mergeAudioChunks([new Float32Array([0.1, 0.2]), new Float32Array([0.3])]);
assert(merged.length === 3 && Math.abs(merged[2] - 0.3) < 0.000_001, "録音の断片を順番に結合する");

console.info("PASS: Whisperへ渡すWAV録音データを検証しました");
