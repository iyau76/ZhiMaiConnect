/**
 * 轻量声纹（说话人特征）提取：完全在浏览器本地完成。
 * 做法：解码 → 单声道 16k → 分帧加窗 → FFT → 40 维梅尔能量 → 取对数 →
 * 全段做均值/标准差统计（CMVN 思路）→ 80 维向量 → L2 归一化。
 *
 * 注意：这是一个统计式的近似声纹，只能给出「疑似同一说话人」的参考，
 * 不具备司法鉴定效力，不能作为证据使用。
 */

const SAMPLE_RATE = 16000;
const FRAME = 512;
const HOP = 256;
const MELS = 40;

/** 迭代基-2 FFT，返回幅度谱（长度 n/2） */
function magnitudeSpectrum(input: Float32Array) {
  const n = input.length;
  const re = Float32Array.from(input);
  const im = new Float32Array(n);

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }

  const half = n >> 1;
  const out = new Float32Array(half);
  for (let i = 0; i < half; i += 1) out[i] = Math.hypot(re[i], im[i]);
  return out;
}

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

function melFilterbank(bins: number) {
  const low = hzToMel(80);
  const high = hzToMel(SAMPLE_RATE / 2);
  const points = new Array(MELS + 2)
    .fill(0)
    .map((_, i) => melToHz(low + ((high - low) * i) / (MELS + 1)))
    .map((hz) => Math.floor((bins * 2 * hz) / SAMPLE_RATE));

  const filters: Array<{ start: number; end: number; peak: number }> = [];
  for (let m = 1; m <= MELS; m += 1) {
    filters.push({ start: points[m - 1], end: points[m + 1], peak: points[m] });
  }
  return filters;
}

async function decodeToMono(blob: Blob): Promise<Float32Array> {
  const buffer = await blob.arrayBuffer();
  const Ctx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buffer.slice(0));
  } finally {
    void ctx.close();
  }

  const channel = decoded.getChannelData(0);
  const ratio = decoded.sampleRate / SAMPLE_RATE;
  if (Math.abs(ratio - 1) < 0.01) return Float32Array.from(channel);
  const length = Math.floor(channel.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = channel[Math.floor(i * ratio)];
  return out;
}

export interface VoiceEmbedding {
  vector: number[];
  durationMs: number;
  /** 有效语音帧数，太少说明录音太短或太安静 */
  frames: number;
}

/** 从一段音频里提取声纹向量 */
export async function extractVoiceEmbedding(blob: Blob): Promise<VoiceEmbedding> {
  const samples = await decodeToMono(blob);
  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  if (samples.length < FRAME * 8) throw new Error("录音太短，至少需要 1 秒有效语音");

  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1)
    window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  const filters = melFilterbank(FRAME >> 1);
  const acc: number[][] = [];
  const frame = new Float32Array(FRAME);

  for (let offset = 0; offset + FRAME <= samples.length; offset += HOP) {
    let energy = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const value = samples[offset + i];
      energy += value * value;
      frame[i] = value * window[i];
    }
    // 简易静音门限，跳过背景噪声帧
    if (energy / FRAME < 1e-5) continue;

    const spectrum = magnitudeSpectrum(frame);
    const mel: number[] = [];
    for (const filter of filters) {
      let sum = 0;
      for (let bin = filter.start; bin <= filter.end && bin < spectrum.length; bin += 1) {
        const weight =
          bin <= filter.peak
            ? (bin - filter.start) / Math.max(1, filter.peak - filter.start)
            : (filter.end - bin) / Math.max(1, filter.end - filter.peak);
        sum += spectrum[bin] * Math.max(0, weight);
      }
      mel.push(Math.log(sum + 1e-8));
    }
    acc.push(mel);
  }

  if (acc.length < 8) throw new Error("没有检测到足够的语音内容，请靠近麦克风重录");

  const mean = new Array(MELS).fill(0);
  for (const row of acc) for (let i = 0; i < MELS; i += 1) mean[i] += row[i] / acc.length;
  const std = new Array(MELS).fill(0);
  for (const row of acc)
    for (let i = 0; i < MELS; i += 1) std[i] += (row[i] - mean[i]) ** 2 / acc.length;

  const vector = [...mean, ...std.map((value) => Math.sqrt(value))];
  const norm = Math.hypot(...vector) || 1;
  return { vector: vector.map((value) => value / norm), durationMs, frames: acc.length };
}

/** 余弦相似度，范围约 -1~1，越大越像 */
export function voiceSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

/** 经验阈值：>0.92 疑似同一人，0.85~0.92 存疑 */
export const VOICE_MATCH_THRESHOLD = 0.92;
export const VOICE_MAYBE_THRESHOLD = 0.85;
