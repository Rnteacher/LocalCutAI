/** Waveform data for rendering audio visuals on timeline clips */
export interface WaveformData {
  mediaAssetId: string;
  sampleRate: number; // Rate of the peak data (e.g., 200 peaks/sec)
  channels: number;
  peaks: number[][]; // One array per channel, values -1.0 to 1.0
  duration: number; // Total duration in seconds
}

/** Audio mixer state for the mixer panel */
export interface MixerChannelState {
  trackId: string;
  volume: number; // Current fader position
  pan: number; // Pan knob position
  peakL: number; // Current peak meter left
  peakR: number; // Current peak meter right
  muted: boolean;
  solo: boolean;
}

/** Master mixer state */
export interface MasterMixerState {
  volume: number;
  peakL: number;
  peakR: number;
  limiterEnabled: boolean;
}
