import type { ID, Resolution, FrameRate } from './project.js';

export type JobType =
  | 'export'
  | 'proxy'
  | 'waveform'
  | 'thumbnail'
  | 'ai-upscale'
  | 'ai-interpolation'
  | 'ai-segment'
  | 'ai-transcribe';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: ID;
  projectId: ID;
  type: JobType;
  status: JobStatus;
  progress: number; // 0.0 - 1.0
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  params: ExportParams | ProxyParams | WaveformParams | AIParams;
}

export interface ExportParams {
  sequenceId: ID;
  outputPath: string;
  format: 'mp4' | 'mov' | 'webm' | 'mkv';
  videoCodec: 'h264' | 'h265' | 'vp9' | 'av1' | 'prores';
  audioCodec: 'aac' | 'pcm' | 'opus';
  resolution: Resolution;
  frameRate: FrameRate;
  videoBitrate: string; // e.g. '10M'
  audioBitrate: string; // e.g. '320k'
  pixelFormat: string; // e.g. 'yuv420p'
  range?: {
    inPoint: number; // Frame number
    outPoint: number;
  };
}

export interface ProxyParams {
  mediaAssetId: ID;
  resolution: Resolution;
  codec: string;
}

export interface WaveformParams {
  mediaAssetId: ID;
  peaksPerSecond: number; // Typically 200-400
}

export interface AIParams {
  type: 'upscale' | 'interpolation' | 'segment' | 'transcribe';
  inputPath: string;
  outputPath: string;
  model: string;
  options: Record<string, unknown>;
}
