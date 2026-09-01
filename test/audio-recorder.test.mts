import { encodeWav, mergeAudioChunks, startAudioRecorder } from "../src/audio-recorder.js";

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

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
try {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  let unsupported = false;
  try { await startAudioRecorder(); }
  catch (error) { unsupported = error instanceof Error && error.message.includes("マイクを使えません"); }
  assert(unsupported, "マイクAPIがない環境では利用者向けエラーを返す");

  let stopped = false;
  let closed = false;
  type FakeProcessor = {
    onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
    connect: () => void;
    disconnect: () => void;
  };
  const processorState: { value: FakeProcessor | null } = { value: null };
  class FakeAudioContext {
    sampleRate = 16_000;
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      processorState.value = { onaudioprocess: null, connect() {}, disconnect() {} };
      return processorState.value;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { closed = true; }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped = true; } }] }) } },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { AudioContext: FakeAudioContext },
  });
  const recorder = await startAudioRecorder();
  processorState.value?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.25]) } });
  const recorded = await recorder.stop();
  assert(recorded.length === 48, "録音した2サンプルをWAVへ変換する");
  assert(stopped && closed, "録音停止時にマイクとAudioContextを解放する");
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete (globalThis as { navigator?: Navigator }).navigator;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete (globalThis as { window?: Window }).window;
}

console.info("PASS: Whisperへ渡すWAV録音データを検証しました");
