import type { ID, FrameRate, Resolution, TimeValue } from './project.js';
import type { Keyframe } from './keyframe.js';

export interface Sequence {
  id: ID;
  projectId: ID;
  name: string;
  frameRate: FrameRate;
  resolution: Resolution;
  duration: TimeValue; // Computed: end of last clip
  tracks: Track[]; // Ordered top-to-bottom (V3, V2, V1, A1, A2, A3)
  createdAt: string;
  updatedAt: string;
}

export type TrackType = 'video' | 'audio';

export interface Track {
  id: ID;
  sequenceId: ID;
  name: string;
  type: TrackType;
  index: number; // Visual order (0 = topmost video or first audio)
  locked: boolean;
  visible: boolean; // For video tracks: toggle visibility
  muted: boolean; // For audio tracks: toggle mute
  solo: boolean; // For audio tracks: solo mode
  volume: number; // Track-level gain 0.0 - 2.0 (1.0 = unity)
  pan: number; // Track-level stereo pan -1.0 to 1.0
  clips: ClipItem[]; // Clips on this track, sorted by startTime
}

export type ClipType = 'video' | 'audio' | 'image' | 'gap';

export interface ClipItem {
  id: ID;
  trackId: ID;
  mediaAssetId: ID | null; // null for gap clips
  type: ClipType;
  name: string;

  // Timeline position (in sequence frames)
  startTime: TimeValue; // Where this clip begins on the timeline
  duration: TimeValue; // How long the clip occupies on the timeline

  // Source media range
  sourceInPoint: TimeValue; // In-point within the source media
  sourceOutPoint: TimeValue; // Out-point within the source media

  // Audio properties (per-clip)
  volume: number; // Clip-level gain 0.0 - 2.0
  pan: number; // Clip-level pan -1.0 to 1.0
  audioEnvelope: AudioEnvelopePoint[]; // Gain automation points

  // Transform properties (for video/image clips)
  transform: TransformState;

  // Visual properties
  opacity: number; // 0.0 - 1.0
  blendMode: BlendMode;
  blendParams?: ClipBlendParams;

  // Keyframes for animated properties
  keyframes: Keyframe[];

  // Transitions
  transitionIn: TransitionData | null;
  transitionOut: TransitionData | null;

  // AI-generated masks
  masks: ManualMaskData[];

  // Synthetic clips and layer effects
  generator: GeneratorData | null;

  // Flags
  disabled: boolean;
}

export interface AudioEnvelopePoint {
  time: TimeValue; // Relative to clip start
  gain: number; // 0.0 - 2.0
}

export interface TransformState {
  positionX: number; // Pixels from center
  positionY: number;
  scaleX: number; // 1.0 = 100%
  scaleY: number;
  rotation: number; // Degrees
  anchorX: number; // Anchor point
  anchorY: number;
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'add'
  | 'silhouette-alpha'
  | 'silhouette-luma';

export interface TransitionData {
  id: ID;
  type: TransitionType;
  duration: TimeValue;
  params?: Record<string, number>;
  audioCrossfade?: boolean;
}

export type TransitionType = 'cross-dissolve' | 'fade-black';

export interface ClipBlendParams {
  silhouetteGamma?: number;
}

export interface MaskPoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface MaskShapeKeyframe {
  id: ID;
  frame: number;
  points: MaskPoint[];
}

export interface ManualMaskData {
  id: ID;
  name: string;
  mode: 'add' | 'subtract' | 'intersect';
  closed: boolean;
  invert: boolean;
  opacity: number;
  feather: number;
  expansion: number;
  keyframes: MaskShapeKeyframe[];
}

export interface GeneratorData {
  kind: 'black-video' | 'color-matte' | 'adjustment-layer';
  color?: string;
}
