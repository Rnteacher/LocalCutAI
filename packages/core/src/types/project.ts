/** Unique identifier type for all entities */
export type ID = string; // nanoid-generated

/** Frames-per-second as a rational number for precision */
export interface FrameRate {
  num: number; // e.g. 24000
  den: number; // e.g. 1001 for 23.976fps
}

/** Time representation in frames at a given rate */
export interface TimeValue {
  frames: number;
  rate: FrameRate;
}

export interface Resolution {
  width: number;
  height: number;
}

export interface Project {
  id: ID;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
  projectDir: string; // Absolute path to project folder
  settings: ProjectSettings;
  sequences: ID[]; // Ordered list of sequence IDs
  mediaAssets: ID[]; // All imported media
}

export interface ProjectSettings {
  defaultFrameRate: FrameRate;
  defaultResolution: Resolution;
  proxyEnabled: boolean;
  proxyResolution: Resolution;
  audioSampleRate: number; // 48000
  audioBitDepth: number; // 16 or 24
}

export type MediaType = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: ID;
  projectId: ID;
  name: string;
  type: MediaType;
  filePath: string; // Absolute path to source file
  mimeType: string;
  fileSize: number; // bytes
  duration: number | null; // seconds, null for images
  frameRate: FrameRate | null;
  resolution: Resolution | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  codec: string | null;
  importedAt: string;
  thumbnailPath: string | null;
  waveformDataPath: string | null; // Path to extracted waveform JSON
  proxy: ProxyAsset | null;
  metadata: Record<string, unknown>; // Extensible metadata from ffprobe
}

export interface ProxyAsset {
  id: ID;
  mediaAssetId: ID;
  filePath: string;
  resolution: Resolution;
  codec: string;
  status: 'pending' | 'generating' | 'ready' | 'failed';
}

/** Folder / bin for organizing media */
export interface MediaBin {
  id: ID;
  projectId: ID;
  name: string;
  parentBinId: ID | null;
  mediaAssetIds: ID[];
}
