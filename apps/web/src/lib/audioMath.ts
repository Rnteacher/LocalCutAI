export type AudioChannelMode = 'stereo' | 'mono-left' | 'mono-right' | 'mono-sum';

export interface RoutingMatrix {
  ll: number;
  lr: number;
  rl: number;
  rr: number;
}

export function applyGain(samples: Float32Array, gain: number): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

export function mixBuffers(sources: Float32Array[]): Float32Array {
  if (sources.length === 0) return new Float32Array(0);
  const maxLen = Math.max(...sources.map((s) => s.length));
  const out = new Float32Array(maxLen);
  for (const src of sources) {
    for (let i = 0; i < src.length; i++) out[i] += src[i];
  }
  return out;
}

export function computePeakDbfs(channels: Float32Array[]): number[] {
  return channels.map((ch) => {
    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
    return peak <= 1e-7 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak);
  });
}

export function dbfsToMeterLevel(dbfs: number, floor = -60): number {
  if (!Number.isFinite(dbfs)) return 0;
  return Math.max(0, Math.min(1, (dbfs - floor) / (0 - floor)));
}

export function dbToGain(db: number): number {
  // Treat the bottom of the UI range as -Infinity (hard mute).
  if (!Number.isFinite(db) || db <= -59.5) return 0;
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0.000001) return -60;
  return 20 * Math.log10(gain);
}

export function normalizePan(pan: number): number {
  if (!Number.isFinite(pan)) return 0;
  return Math.max(-1, Math.min(1, pan));
}

export function applyStereoBalance(pan: number): { left: number; right: number } {
  const p = normalizePan(pan);
  const left = p <= 0 ? 1 : 1 - p;
  const right = p >= 0 ? 1 : 1 + p;
  return {
    left: Math.max(0, left),
    right: Math.max(0, right),
  };
}

export function resolveChannelMode(
  mode?: 'stereo' | 'mono',
  map?: 'L+R' | 'L' | 'R',
): AudioChannelMode {
  if (mode !== 'mono') return 'stereo';
  if (map === 'L') return 'mono-left';
  if (map === 'R') return 'mono-right';
  return 'mono-sum';
}

export function applyChannelMode(mode: AudioChannelMode): RoutingMatrix {
  switch (mode) {
    case 'stereo':
      return { ll: 1, lr: 0, rl: 0, rr: 1 };
    case 'mono-left':
      return { ll: 1, lr: 1, rl: 0, rr: 0 };
    case 'mono-right':
      return { ll: 0, lr: 0, rl: 1, rr: 1 };
    case 'mono-sum':
      return { ll: 0.5, lr: 0.5, rl: 0.5, rr: 0.5 };
    default:
      return { ll: 1, lr: 0, rl: 0, rr: 1 };
  }
}

export function buildRoutingMatrix(mode: AudioChannelMode, pan: number): RoutingMatrix {
  const base = applyChannelMode(mode);
  const balance = applyStereoBalance(pan);
  return {
    ll: base.ll * balance.left,
    rl: base.rl * balance.left,
    lr: base.lr * balance.right,
    rr: base.rr * balance.right,
  };
}
