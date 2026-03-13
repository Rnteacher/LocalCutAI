/**
 * Zustand store for project-level state management.
 *
 * Milestone 2 additions:
 *   - Clip transform/opacity/speed fields
 *   - Undo/redo history stack (_history / _future)
 *   - splitClipAtPlayhead, updateClipProperties, rippleTrimClip, rippleDeleteClips
 *   - trimClip now adjusts sourceInFrame/sourceOutFrame properly
 */

import { create } from 'zustand';
import { api } from '../lib/api.js';
import type { ApiMediaDedupeResult, ApiProject, ApiMediaAsset, ApiSequence } from '../lib/api.js';

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/** Shape of a clip in the sequence JSON data */
export type TimelineBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'add'
  | 'silhouette-alpha'
  | 'silhouette-luma';

export type TimelineTransitionType = 'cross-dissolve' | 'fade-black';

export interface TransitionData {
  id: string;
  type: TimelineTransitionType;
  durationFrames: number;
  audioCrossfade?: boolean;
}

export interface TimelineKeyframeData {
  id: string;
  property:
    | 'opacity'
    | 'speed'
    | 'volume'
    | 'pan'
    | 'brightness'
    | 'contrast'
    | 'saturation'
    | 'hue'
    | 'vignette'
    | 'transform.positionX'
    | 'transform.positionY'
    | 'transform.scaleX'
    | 'transform.scaleY'
    | 'transform.rotation'
    | 'transform.anchorX'
    | 'transform.anchorY'
    | 'mask.opacity'
    | 'mask.feather'
    | 'mask.expansion';
  frame: number;
  value: number;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'bezier';
  bezierHandles?: { inX: number; inY: number; outX: number; outY: number };
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
  id: string;
  frame: number;
  points: MaskPoint[];
}

export interface ManualMaskData {
  id: string;
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

export interface ClipBlendParams {
  silhouetteGamma?: number;
}

export interface TimelineClipData {
  id: string;
  name: string;
  type: string;
  startFrame: number;
  durationFrames: number;
  mediaAssetId: string | null;
  sourceInFrame?: number;
  sourceOutFrame?: number;
  // Transform (all optional ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â defaults applied at render time)
  opacity?: number; // default 1
  positionX?: number; // default 0 (px offset from center)
  positionY?: number; // default 0
  scaleX?: number; // default 1
  scaleY?: number; // default 1
  rotation?: number; // default 0 (degrees)
  speed?: number; // default 1
  preservePitch?: boolean; // default true
  audioGainDb?: number; // default 0
  gain?: number; // default 1 (linear)
  pan?: number; // default 0 (-1..1)
  audioVolume?: number; // default 1
  audioPan?: number; // default 0 (-1..1)
  audioEqLow?: number; // dB
  audioEqMid?: number; // dB
  audioEqHigh?: number; // dB
  audioEq63?: number; // dB
  audioEq125?: number; // dB
  audioEq250?: number; // dB
  audioEq500?: number; // dB
  audioEq1k?: number; // dB
  audioEq2k?: number; // dB
  audioEq4k?: number; // dB
  audioEq8k?: number; // dB
  brightness?: number; // default 1
  contrast?: number; // default 1
  saturation?: number; // default 1
  hue?: number; // default 0 (deg)
  vignette?: number; // default 0 (-1..1, bright..dark)
  blendMode?: TimelineBlendMode;
  blendParams?: ClipBlendParams;
  keyframes?: TimelineKeyframeData[];
  transitionIn?: TransitionData | null;
  transitionOut?: TransitionData | null;
  masks?: ManualMaskData[];
  generator?: GeneratorData | null;
  linkedClipId?: string;
}

/** Shape of a track in the sequence JSON data */
export interface TimelineTrackData {
  id: string;
  sequenceId: string;
  name: string;
  type: 'video' | 'audio';
  index: number;
  locked: boolean;
  syncLocked?: boolean;
  visible: boolean;
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  channelMode?: 'stereo' | 'mono';
  channelMap?: 'L+R' | 'L' | 'R';
  clips: TimelineClipData[];
}

/** Shape of the sequence.data JSON */
interface SequenceData {
  tracks: TimelineTrackData[];
  frameRate?: { num: number; den: number };
}

// ---------------------------------------------------------------------------
// History (undo/redo)
// ---------------------------------------------------------------------------

const MAX_HISTORY = 50;
let clipPropsMutationToken = 0;
let clipKeyframeMutationToken = 0;
const sequenceUpdateQueues = new Map<string, Promise<ApiSequence>>();
type SequenceUpdatePayload = Parameters<typeof api.sequences.update>[1];

async function enqueueSequenceUpdate(
  sequenceId: string,
  payload: SequenceUpdatePayload,
): Promise<ApiSequence> {
  const prev = sequenceUpdateQueues.get(sequenceId) ?? Promise.resolve(undefined as unknown as ApiSequence);
  const next = prev
    .catch(() => undefined as unknown as ApiSequence)
    .then(() => api.sequences.update(sequenceId, payload));

  sequenceUpdateQueues.set(sequenceId, next);

  try {
    return await next;
  } finally {
    if (sequenceUpdateQueues.get(sequenceId) === next) {
      sequenceUpdateQueues.delete(sequenceId);
    }
  }
}

interface HistoryEntry {
  data: SequenceData;
  seqId: string;
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

interface ProjectState {
  // Data
  projects: ApiProject[];
  currentProject: ApiProject | null;
  mediaAssets: ApiMediaAsset[];
  sequences: ApiSequence[];

  // UI
  isLoading: boolean;
  error: string | null;

  // History (undo/redo)
  _history: HistoryEntry[];
  _future: HistoryEntry[];
  _pushHistory: () => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Actions
  fetchProjects: () => Promise<void>;
  createProject: (name: string, settings?: Record<string, unknown>) => Promise<ApiProject>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  deleteProject: (id: string) => Promise<void>;
  updateProjectSettings: (settings: {
    defaultFrameRate?: { num: number; den: number };
    defaultResolution?: { width: number; height: number };
    audioSampleRate?: number;
    aspectRatio?: string;
    audioChannels?: number;
  }) => Promise<void>;
  importMedia: (filePaths: string[]) => Promise<void>;
  pickMedia: () => Promise<ApiMediaAsset[]>;
  uploadMedia: (files: FileList | File[]) => Promise<ApiMediaAsset[]>;
  dedupeMedia: () => Promise<ApiMediaDedupeResult | null>;
  deleteMedia: (assetId: string) => Promise<void>;
  setError: (error: string | null) => void;

  // Timeline editing
  addClipToTrack: (params: {
    trackId: string;
    asset: ApiMediaAsset;
    startFrame: number;
    sourceInFrame?: number;
    sourceOutFrame?: number;
    insertMode?: 'overwrite' | 'ripple';
    audioOnly?: boolean;
  }) => Promise<void>;
  addGeneratorClip: (params: {
    trackId: string;
    generator: GeneratorData;
    name?: string;
    startFrame: number;
    durationFrames?: number;
    insertMode?: 'overwrite' | 'ripple';
  }) => Promise<void>;
  addTrack: (type: 'video' | 'audio') => Promise<string | null>;
  removeClips: (clipIds: string[]) => Promise<void>;
  moveClip: (
    clipId: string,
    newTrackId: string,
    newStartFrame: number,
    options?: { unlink?: boolean },
  ) => Promise<void>;
  trimClip: (
    clipId: string,
    newStartFrame: number,
    newDurationFrames: number,
    options?: { unlink?: boolean },
  ) => Promise<void>;

  // Milestone 2 actions
  splitClipAtPlayhead: (clipId: string, frame: number) => Promise<void>;
  updateClipProperties: (clipId: string, props: Partial<TimelineClipData>) => Promise<void>;
  upsertClipKeyframe: (clipId: string, keyframe: TimelineKeyframeData) => Promise<void>;
  removeClipKeyframe: (clipId: string, keyframeId: string) => Promise<void>;
  setClipTransition: (
    clipId: string,
    side: 'in' | 'out',
    transition: TransitionData | null,
  ) => Promise<void>;
  addClipMask: (clipId: string, mask: ManualMaskData) => Promise<void>;
  updateClipMask: (
    clipId: string,
    maskId: string,
    patch: Partial<Omit<ManualMaskData, 'id'>>,
  ) => Promise<void>;
  removeClipMask: (clipId: string, maskId: string) => Promise<void>;
  upsertMaskShapeKeyframe: (
    clipId: string,
    maskId: string,
    keyframe: MaskShapeKeyframe,
  ) => Promise<void>;
  removeMaskShapeKeyframe: (clipId: string, maskId: string, keyframeId: string) => Promise<void>;
  insertMaskPointAcrossKeyframes: (
    clipId: string,
    maskId: string,
    params: { frame: number; insertAt: number; point?: MaskPoint },
  ) => Promise<void>;
  removeMaskPointAcrossKeyframes: (clipId: string, maskId: string, pointIndex: number) => Promise<void>;
  rippleTrimClip: (
    clipId: string,
    newStartFrame: number,
    newDurationFrames: number,
    options?: { unlink?: boolean },
  ) => Promise<void>;
  rippleDeleteClips: (clipIds: string[]) => Promise<void>;
  liftRangeByInOut: (
    inFrame: number,
    outFrame: number,
    options?: {
      selectedClipIds?: string[];
      targetTrackIds?: string[];
      includeLinked?: boolean;
      useSyncLock?: boolean;
    },
  ) => Promise<void>;
  extractRangeByInOut: (
    inFrame: number,
    outFrame: number,
    options?: {
      selectedClipIds?: string[];
      targetTrackIds?: string[];
      includeLinked?: boolean;
      useSyncLock?: boolean;
    },
  ) => Promise<void>;

  // Milestone 3 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â track management
  updateTrack: (
    trackId: string,
    props: Partial<
      Pick<
        TimelineTrackData,
        | 'muted'
        | 'solo'
        | 'locked'
        | 'syncLocked'
        | 'volume'
        | 'pan'
        | 'visible'
        | 'channelMode'
        | 'channelMap'
      >
    >,
  ) => Promise<void>;
  isTrackLocked: (trackId: string) => boolean;
  unlinkSelectedClips: (clipIds: string[]) => Promise<void>;
  relinkSelectedClips: (clipIds: string[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function mergeMediaAssets(existing: ApiMediaAsset[], incoming: ApiMediaAsset[]): ApiMediaAsset[] {
  const map = new Map(existing.map((asset) => [asset.id, asset] as const));
  for (const asset of incoming) {
    map.set(asset.id, asset);
  }
  return [...map.values()];
}

function isAbsoluteLocalPath(value: string): boolean {
  if (!value || value.includes('fakepath')) return false;
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function extractNativeFilePath(file: File): string | null {
  const candidate = (file as File & { path?: unknown; filepath?: unknown }).path
    ?? (file as File & { path?: unknown; filepath?: unknown }).filepath;
  return typeof candidate === 'string' && isAbsoluteLocalPath(candidate) ? candidate : null;
}

function normalizeTransitionType(raw: unknown): TimelineTransitionType {
  if (raw === 'cross-dissolve' || raw === 'fade-black') {
    return raw;
  }
  if (raw === 'dissolve' || raw === 'wipe-left' || raw === 'wipe-right') {
    return 'cross-dissolve';
  }
  return 'cross-dissolve';
}

function normalizeTransition(raw: unknown): TransitionData | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    id?: unknown;
    type?: unknown;
    durationFrames?: unknown;
    duration?: { frames?: unknown };
    audioCrossfade?: unknown;
  };
  const durationFramesRaw =
    typeof obj.durationFrames === 'number'
      ? obj.durationFrames
      : typeof obj.duration?.frames === 'number'
        ? obj.duration.frames
        : 0;
  const durationFrames = Math.max(0, Math.round(durationFramesRaw));
  if (durationFrames <= 0) return null;
  const type = normalizeTransitionType(obj.type);
  return {
    id: typeof obj.id === 'string' && obj.id.trim().length > 0 ? obj.id : generateId(),
    type,
    durationFrames,
    audioCrossfade:
      typeof obj.audioCrossfade === 'boolean'
        ? obj.audioCrossfade
        : type === 'cross-dissolve'
          ? true
          : false,
  };
}

function sortTrackClipsByStart(clips: TimelineClipData[]): TimelineClipData[] {
  return [...clips].sort((a, b) => {
    if (a.startFrame !== b.startFrame) return a.startFrame - b.startFrame;
    return a.id.localeCompare(b.id);
  });
}

function findAdjacentClipAtCut(
  track: TimelineTrackData | null,
  clip: TimelineClipData | null,
  side: 'in' | 'out',
): TimelineClipData | null {
  if (!track || !clip) return null;
  const sorted = sortTrackClipsByStart(track.clips);
  const idx = sorted.findIndex((c) => c.id === clip.id);
  if (idx < 0) return null;
  if (side === 'in') {
    const prev = sorted[idx - 1];
    if (!prev) return null;
    return prev.startFrame + prev.durationFrames === clip.startFrame ? prev : null;
  }
  const next = sorted[idx + 1];
  if (!next) return null;
  return clip.startFrame + clip.durationFrames === next.startFrame ? next : null;
}

function estimateMediaTotalFrames(asset: ApiMediaAsset | undefined, fallbackFps: number): number | null {
  if (!asset || typeof asset.duration !== 'number' || asset.duration <= 0) return null;
  const fps =
    asset.frameRate && asset.frameRate.num > 0 && asset.frameRate.den > 0
      ? asset.frameRate.num / asset.frameRate.den
      : fallbackFps;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.max(1, Math.round(asset.duration * fps));
}

function computeClipSourceHandles(
  clip: TimelineClipData,
  mediaById: Map<string, ApiMediaAsset>,
  fallbackFps: number,
): { head: number; tail: number } {
  const sourceIn = Math.max(0, Math.round(clip.sourceInFrame ?? 0));
  const inferredOut = sourceIn + Math.max(1, Math.round(clip.durationFrames));
  const sourceOut = Math.max(sourceIn + 1, Math.round(clip.sourceOutFrame ?? inferredOut));

  if (!clip.mediaAssetId) {
    return { head: 100000, tail: 100000 };
  }

  const media = mediaById.get(clip.mediaAssetId);
  const estimatedTotal = estimateMediaTotalFrames(media, fallbackFps);
  const totalFrames =
    estimatedTotal != null ? Math.max(estimatedTotal, sourceOut) : sourceOut + Math.max(0, clip.durationFrames);

  return {
    head: sourceIn,
    tail: Math.max(0, totalFrames - sourceOut),
  };
}

export interface TransitionSideLimit {
  maxDurationFrames: number;
  clampedDurationFrames: number;
  neighborClipId: string | null;
  neighborSide: 'in' | 'out' | null;
  centeredOnCut: boolean;
}

export function computeTransitionSideLimit(options: {
  track: TimelineTrackData | null;
  clip: TimelineClipData | null;
  side: 'in' | 'out';
  type: TimelineTransitionType;
  requestedDurationFrames: number;
  mediaAssets: ApiMediaAsset[];
  fps: number;
}): TransitionSideLimit {
  const requested = Math.max(1, Math.round(options.requestedDurationFrames));
  const clip = options.clip;
  if (!clip) {
    return {
      maxDurationFrames: requested,
      clampedDurationFrames: requested,
      neighborClipId: null,
      neighborSide: null,
      centeredOnCut: false,
    };
  }

  const baseMax = Math.max(1, Math.round(clip.durationFrames));
  if (options.type !== 'cross-dissolve') {
    return {
      maxDurationFrames: baseMax,
      clampedDurationFrames: Math.min(requested, baseMax),
      neighborClipId: null,
      neighborSide: null,
      centeredOnCut: false,
    };
  }

  const neighbor = findAdjacentClipAtCut(options.track, clip, options.side);
  if (!neighbor) {
    return {
      maxDurationFrames: baseMax,
      clampedDurationFrames: Math.min(requested, baseMax),
      neighborClipId: null,
      neighborSide: null,
      centeredOnCut: false,
    };
  }

  const mediaById = new Map(options.mediaAssets.map((a) => [a.id, a]));
  const clipHandles = computeClipSourceHandles(clip, mediaById, options.fps);
  const neighborHandles = computeClipSourceHandles(neighbor, mediaById, options.fps);
  const clipHalfHandle = options.side === 'in' ? clipHandles.head : clipHandles.tail;
  const neighborHalfHandle = options.side === 'in' ? neighborHandles.tail : neighborHandles.head;
  const maxHalf = Math.floor(
    Math.max(
      0,
      Math.min(
        clipHalfHandle,
        neighborHalfHandle,
        Math.max(1, Math.round(clip.durationFrames)),
        Math.max(1, Math.round(neighbor.durationFrames)),
      ),
    ),
  );
  const maxDurationFrames = Math.max(1, maxHalf * 2);

  return {
    maxDurationFrames,
    clampedDurationFrames: Math.min(requested, maxDurationFrames),
    neighborClipId: neighbor.id,
    neighborSide: options.side === 'in' ? 'out' : 'in',
    centeredOnCut: true,
  };
}

function normalizeKeyframes(raw: unknown): TimelineKeyframeData[] {
  if (!Array.isArray(raw)) return [];
  const normalized: TimelineKeyframeData[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const kf = item as Partial<TimelineKeyframeData> & { time?: { frames?: number } };
    const frame = Math.max(
      0,
      Math.round(
        typeof kf.frame === 'number' ? kf.frame : typeof kf.time?.frames === 'number' ? kf.time.frames : 0,
      ),
    );
    if (typeof kf.property !== 'string' || typeof kf.value !== 'number') continue;
    const easing =
      kf.easing === 'linear' ||
      kf.easing === 'ease-in' ||
      kf.easing === 'ease-out' ||
      kf.easing === 'ease-in-out' ||
      kf.easing === 'bezier'
        ? kf.easing
        : 'linear';
    normalized.push({
      id: typeof kf.id === 'string' && kf.id.trim().length > 0 ? kf.id : generateId(),
      property: kf.property as TimelineKeyframeData['property'],
      frame,
      value: kf.value,
      easing,
      bezierHandles: kf.bezierHandles,
    });
  }
  normalized.sort((a, b) => a.frame - b.frame);
  return normalized;
}

function normalizeMasks(raw: unknown): ManualMaskData[] {
  if (!Array.isArray(raw)) return [];
  const masks: ManualMaskData[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Partial<ManualMaskData>;
    const keyframesRaw = Array.isArray(m.keyframes) ? m.keyframes : [];
    const keyframes: MaskShapeKeyframe[] = [];
    for (const kItem of keyframesRaw) {
      if (!kItem || typeof kItem !== 'object') continue;
      const k = kItem as Partial<MaskShapeKeyframe>;
      const pointsRaw = Array.isArray(k.points) ? k.points : [];
      const points: MaskPoint[] = pointsRaw
        .map((p) => {
          if (!p || typeof p !== 'object') return null;
          const point = p as Partial<MaskPoint>;
          const x = typeof point.x === 'number' ? point.x : 0;
          const y = typeof point.y === 'number' ? point.y : 0;
          return {
            x,
            y,
            inX: typeof point.inX === 'number' ? point.inX : x,
            inY: typeof point.inY === 'number' ? point.inY : y,
            outX: typeof point.outX === 'number' ? point.outX : x,
            outY: typeof point.outY === 'number' ? point.outY : y,
          };
        })
        .filter((p): p is MaskPoint => p != null);

      keyframes.push({
        id: typeof k.id === 'string' && k.id.trim().length > 0 ? k.id : generateId(),
        frame: Math.max(0, Math.round(typeof k.frame === 'number' ? k.frame : 0)),
        points,
      });
    }
    keyframes.sort((a, b) => a.frame - b.frame);
    masks.push({
      id: typeof m.id === 'string' && m.id.trim().length > 0 ? m.id : generateId(),
      name: typeof m.name === 'string' && m.name.trim().length > 0 ? m.name : 'Mask',
      mode: m.mode === 'subtract' || m.mode === 'intersect' ? m.mode : 'add',
      closed: m.closed !== false,
      invert: m.invert === true,
      opacity:
        typeof m.opacity === 'number'
          ? Math.max(0, Math.min(1, m.opacity))
          : 1,
      feather:
        typeof m.feather === 'number'
          ? Math.max(0, m.feather)
          : 0,
      expansion:
        typeof m.expansion === 'number'
          ? m.expansion
          : 0,
      keyframes,
    });
  }
  return masks;
}

function cloneMaskPoint(point: MaskPoint): MaskPoint {
  return {
    x: point.x,
    y: point.y,
    inX: point.inX,
    inY: point.inY,
    outX: point.outX,
    outY: point.outY,
  };
}

function midpointMaskPoint(a: MaskPoint, b: MaskPoint): MaskPoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    inX: (a.inX + b.inX) / 2,
    inY: (a.inY + b.inY) / 2,
    outX: (a.outX + b.outX) / 2,
    outY: (a.outY + b.outY) / 2,
  };
}

function fallbackInsertedMaskPoint(points: MaskPoint[], insertAt: number): MaskPoint {
  if (points.length === 0) {
    return { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 };
  }
  if (insertAt <= 0) {
    return cloneMaskPoint(points[0]);
  }
  if (insertAt >= points.length) {
    return cloneMaskPoint(points[points.length - 1]);
  }
  return midpointMaskPoint(points[insertAt - 1], points[insertAt]);
}

function normalizeGenerator(raw: unknown): GeneratorData | null {
  if (!raw || typeof raw !== 'object') return null;
  const generator = raw as Partial<GeneratorData>;
  if (
    generator.kind !== 'black-video' &&
    generator.kind !== 'color-matte' &&
    generator.kind !== 'adjustment-layer'
  ) {
    return null;
  }
  if (generator.kind === 'color-matte') {
    const color =
      typeof generator.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(generator.color)
        ? generator.color
        : '#000000';
    return { kind: 'color-matte', color };
  }
  return { kind: generator.kind };
}

function normalizeClip(clip: TimelineClipData): TimelineClipData {
  return {
    ...clip,
    blendMode: clip.blendMode ?? 'normal',
    blendParams: {
      silhouetteGamma: clip.blendParams?.silhouetteGamma ?? 1,
    },
    keyframes: normalizeKeyframes(clip.keyframes),
    transitionIn: normalizeTransition(clip.transitionIn),
    transitionOut: normalizeTransition(clip.transitionOut),
    masks: normalizeMasks(clip.masks),
    generator: normalizeGenerator(clip.generator),
  };
}

function getSeqData(seq: ApiSequence): SequenceData {
  const raw = seq.data as unknown;
  if (!raw || typeof raw !== 'object') {
    return { tracks: [] };
  }

  const data = raw as { tracks?: unknown; frameRate?: { num: number; den: number } };
  const tracksRaw = Array.isArray(data.tracks) ? (data.tracks as TimelineTrackData[]) : [];
  const tracks = tracksRaw.map((t, i) => {
    const channelMode: 'stereo' | 'mono' = t.channelMode === 'mono' ? 'mono' : 'stereo';
    const channelMap: 'L+R' | 'L' | 'R' =
      t.channelMap === 'L' || t.channelMap === 'R' || t.channelMap === 'L+R'
        ? t.channelMap
        : 'L+R';
    return {
      ...t,
      sequenceId: t.sequenceId ?? seq.id,
      locked: t.locked ?? false,
      syncLocked: t.syncLocked ?? true,
      visible: t.visible ?? true,
      muted: t.muted ?? false,
      solo: t.solo ?? false,
      volume: typeof t.volume === 'number' ? t.volume : 1,
      pan: typeof t.pan === 'number' ? t.pan : 0,
      channelMode,
      channelMap,
      index: Number.isFinite(t.index) ? t.index : i,
      clips: (Array.isArray(t.clips) ? t.clips : []).map(normalizeClip),
    };
  });
  return {
    ...data,
    tracks,
  };
}

function cloneClip(clip: TimelineClipData): TimelineClipData {
  return {
    ...clip,
    blendParams: clip.blendParams ? { ...clip.blendParams } : undefined,
    keyframes: (clip.keyframes ?? []).map((kf) => ({
      ...kf,
      bezierHandles: kf.bezierHandles ? { ...kf.bezierHandles } : undefined,
    })),
    transitionIn: clip.transitionIn ? { ...clip.transitionIn } : null,
    transitionOut: clip.transitionOut ? { ...clip.transitionOut } : null,
    masks: (clip.masks ?? []).map((mask) => ({
      ...mask,
      keyframes: mask.keyframes.map((kf) => ({
        ...kf,
        points: kf.points.map((p) => ({ ...p })),
      })),
    })),
    generator: clip.generator ? { ...clip.generator } : null,
  };
}

function overwriteTrackWithClip(
  clips: TimelineClipData[],
  incoming: TimelineClipData,
  excludeClipId?: string,
): TimelineClipData[] {
  const inStart = incoming.startFrame;
  const inEnd = incoming.startFrame + incoming.durationFrames;

  const result: TimelineClipData[] = [];
  for (const clip of clips) {
    if (clip.id === excludeClipId) continue;

    const start = clip.startFrame;
    const end = clip.startFrame + clip.durationFrames;

    if (end <= inStart || start >= inEnd) {
      result.push(cloneClip(clip));
      continue;
    }

    const sourceIn = clip.sourceInFrame ?? 0;

    if (start < inStart) {
      const leftDuration = inStart - start;
      if (leftDuration > 0) {
        result.push({
          ...cloneClip(clip),
          durationFrames: leftDuration,
          sourceOutFrame: sourceIn + leftDuration,
        });
      }
    }

    if (end > inEnd) {
      const rightStart = inEnd;
      const rightDuration = end - inEnd;
      if (rightDuration > 0) {
        const rightOffset = rightStart - start;
        const rightSourceIn = sourceIn + rightOffset;
        result.push({
          ...cloneClip(clip),
          id: generateId(),
          startFrame: rightStart,
          durationFrames: rightDuration,
          sourceInFrame: rightSourceIn,
          sourceOutFrame: rightSourceIn + rightDuration,
        });
      }
    }
  }

  result.push(incoming);
  result.sort((a, b) => a.startFrame - b.startFrame);
  return result;
}

function rippleInsertTrackWithClip(
  clips: TimelineClipData[],
  incoming: TimelineClipData,
): TimelineClipData[] {
  const insertionStart = incoming.startFrame;
  const insertionDur = Math.max(1, incoming.durationFrames);
  const result: TimelineClipData[] = [];

  for (const clip of clips) {
    const start = clip.startFrame;
    const end = clip.startFrame + clip.durationFrames;
    const sourceIn = clip.sourceInFrame ?? 0;

    if (end <= insertionStart) {
      result.push(cloneClip(clip));
      continue;
    }

    if (start >= insertionStart) {
      result.push({ ...cloneClip(clip), startFrame: start + insertionDur });
      continue;
    }

    const leftDur = insertionStart - start;
    if (leftDur > 0) {
      result.push({
        ...cloneClip(clip),
        durationFrames: leftDur,
        sourceOutFrame: sourceIn + leftDur,
      });
    }

    const rightDur = end - insertionStart;
    if (rightDur > 0) {
      const rightSourceIn = sourceIn + leftDur;
      result.push({
        ...cloneClip(clip),
        id: generateId(),
        startFrame: insertionStart + insertionDur,
        durationFrames: rightDur,
        sourceInFrame: rightSourceIn,
        sourceOutFrame: rightSourceIn + rightDur,
      });
    }
  }

  result.push(incoming);
  result.sort((a, b) => a.startFrame - b.startFrame);
  return result;
}

function assetTypeToTrackType(assetType: ApiMediaAsset['type']): TimelineTrackData['type'] {
  return assetType === 'audio' ? 'audio' : 'video';
}

function clipTypeToTrackType(clipType: TimelineClipData['type']): TimelineTrackData['type'] {
  return clipType === 'audio' ? 'audio' : 'video';
}

function parseTrackNumber(name: string, prefix: 'V' | 'A'): number | null {
  const m = name
    .trim()
    .toUpperCase()
    .match(new RegExp(`^${prefix}(\\d+)$`));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function nextTrackName(tracks: TimelineTrackData[], type: 'video' | 'audio'): string {
  const prefix = type === 'video' ? 'V' : 'A';
  const nums = tracks
    .filter((t) => t.type === type)
    .map((t) => parseTrackNumber(t.name, prefix))
    .filter((n): n is number => n != null);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}${next}`;
}

function normalizeTrackIndices(tracks: TimelineTrackData[]): TimelineTrackData[] {
  return tracks.map((t, i) => ({ ...t, index: i }));
}

function ensureBaseTracks(
  data: SequenceData,
  seqId: string,
): { data: SequenceData; changed: boolean } {
  const tracks: TimelineTrackData[] = [];
  for (const t of data.tracks) {
    if (!t || (t.type !== 'video' && t.type !== 'audio')) continue;
    tracks.push({
      ...t,
      sequenceId: t.sequenceId || seqId,
      locked: t.locked ?? false,
      syncLocked: t.syncLocked ?? true,
      visible: t.visible ?? true,
      muted: t.muted ?? false,
      solo: t.solo ?? false,
      volume: t.volume ?? 1,
      pan: t.pan ?? 0,
      channelMode: t.channelMode ?? 'stereo',
      channelMap: t.channelMap ?? 'L+R',
      clips: Array.isArray(t.clips) ? t.clips : [],
    });
  }
  let changed = false;

  const hasV1 = tracks.some((t) => t.type === 'video' && t.name.trim().toUpperCase() === 'V1');
  const hasV2 = tracks.some((t) => t.type === 'video' && t.name.trim().toUpperCase() === 'V2');
  const hasA1 = tracks.some((t) => t.type === 'audio' && t.name.trim().toUpperCase() === 'A1');
  const hasA2 = tracks.some((t) => t.type === 'audio' && t.name.trim().toUpperCase() === 'A2');

  const makeTrack = (name: string, type: 'video' | 'audio'): TimelineTrackData => ({
    id: generateId(),
    sequenceId: seqId,
    name,
    type,
    index: 0,
    locked: false,
    syncLocked: true,
    visible: true,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    channelMode: 'stereo',
    channelMap: 'L+R',
    clips: [],
  });

  if (!hasV2) {
    tracks.unshift(makeTrack('V2', 'video'));
    changed = true;
  }
  if (!hasV1) {
    const firstAudio = tracks.findIndex((t) => t.type === 'audio');
    const insertAt = firstAudio === -1 ? tracks.length : firstAudio;
    tracks.splice(insertAt, 0, makeTrack('V1', 'video'));
    changed = true;
  }
  if (!hasA1) {
    tracks.push(makeTrack('A1', 'audio'));
    changed = true;
  }
  if (!hasA2) {
    tracks.push(makeTrack('A2', 'audio'));
    changed = true;
  }

  const normalized = normalizeTrackIndices(tracks);
  return { data: { ...data, tracks: normalized }, changed };
}

function findPairedAudioTrackId(tracks: TimelineTrackData[], videoTrackId: string): string | null {
  const videoTracks = tracks.filter((t) => t.type === 'video');
  const audioTracks = tracks.filter((t) => t.type === 'audio' && !t.locked);
  if (audioTracks.length === 0) return null;

  const video = videoTracks.find((t) => t.id === videoTrackId);
  if (!video) return audioTracks[0].id;

  const vNum = parseTrackNumber(video.name, 'V');
  if (vNum != null) {
    const named = audioTracks.find((t) => parseTrackNumber(t.name, 'A') === vNum);
    if (named) return named.id;
  }

  const sortedV = [...videoTracks].sort(
    (a, b) => (parseTrackNumber(a.name, 'V') ?? 999) - (parseTrackNumber(b.name, 'V') ?? 999),
  );
  const sortedA = [...audioTracks].sort(
    (a, b) => (parseTrackNumber(a.name, 'A') ?? 999) - (parseTrackNumber(b.name, 'A') ?? 999),
  );
  const vIdx = Math.max(
    0,
    sortedV.findIndex((t) => t.id === videoTrackId),
  );
  const mapped = sortedA[Math.min(vIdx, sortedA.length - 1)];
  return mapped?.id ?? sortedA[0]?.id ?? null;
}

function computeTrimResult(
  clip: TimelineClipData,
  newStartFrame: number,
  newDurationFrames: number,
): {
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  oldEnd: number;
  newEnd: number;
} {
  const oldStartFrame = clip.startFrame;
  const oldEndFrame = clip.startFrame + clip.durationFrames;
  const sourceIn = clip.sourceInFrame ?? 0;
  const minStartFrame = oldStartFrame - sourceIn;
  const requestedStartFrame = Math.max(0, newStartFrame);
  const clampedStartFrame = Math.max(minStartFrame, requestedStartFrame);
  const isLeftTrim = newStartFrame !== oldStartFrame;

  const requestedDuration = Math.max(1, newDurationFrames);
  const clampedDuration = isLeftTrim
    ? Math.max(1, oldEndFrame - clampedStartFrame)
    : requestedDuration;

  const leftDelta = clampedStartFrame - oldStartFrame;
  const newSourceIn = sourceIn + leftDelta;
  const newSourceOut = newSourceIn + clampedDuration;

  return {
    startFrame: clampedStartFrame,
    durationFrames: clampedDuration,
    sourceInFrame: newSourceIn,
    sourceOutFrame: newSourceOut,
    oldEnd: oldEndFrame,
    newEnd: clampedStartFrame + clampedDuration,
  };
}

function cutClipByRange(
  clip: TimelineClipData,
  rangeIn: number,
  rangeOut: number,
  mode: 'lift' | 'extract',
): TimelineClipData[] {
  const clipStart = clip.startFrame;
  const clipEnd = clip.startFrame + clip.durationFrames;
  const sourceIn = clip.sourceInFrame ?? 0;

  if (clipEnd <= rangeIn || clipStart >= rangeOut) {
    if (mode === 'extract' && clipStart >= rangeOut) {
      const shift = rangeOut - rangeIn;
      return [{ ...clip, startFrame: Math.max(0, clipStart - shift) }];
    }
    return [{ ...clip }];
  }

  const pieces: TimelineClipData[] = [];

  if (clipStart < rangeIn) {
    const leftDur = Math.max(0, rangeIn - clipStart);
    if (leftDur > 0) {
      pieces.push({
        ...clip,
        durationFrames: leftDur,
        sourceInFrame: sourceIn,
        sourceOutFrame: sourceIn + leftDur,
      });
    }
  }

  if (clipEnd > rangeOut) {
    const rightDur = Math.max(0, clipEnd - rangeOut);
    if (rightDur > 0) {
      const rightSourceIn = sourceIn + (rangeOut - clipStart);
      const rightStart = mode === 'extract' ? rangeIn : rangeOut;
      pieces.push({
        ...clip,
        id: generateId(),
        startFrame: Math.max(0, rightStart),
        durationFrames: rightDur,
        sourceInFrame: rightSourceIn,
        sourceOutFrame: rightSourceIn + rightDur,
      });
    }
  }

  return pieces;
}

function resolveAffectedTrackIds(
  tracks: TimelineTrackData[],
  options?: {
    selectedClipIds?: string[];
    targetTrackIds?: string[];
    includeLinked?: boolean;
    useSyncLock?: boolean;
  },
): Set<string> {
  const selected = new Set(options?.selectedClipIds ?? []);
  const targeted = new Set(options?.targetTrackIds ?? []);

  if (selected.size > 0) {
    const affected = new Set<string>();
    for (const t of tracks) {
      for (const c of t.clips) {
        if (selected.has(c.id)) {
          affected.add(t.id);
          if (options?.includeLinked && c.linkedClipId) {
            for (const lt of tracks) {
              if (lt.clips.some((x) => x.id === c.linkedClipId)) {
                affected.add(lt.id);
                break;
              }
            }
          }
        }
      }
    }
    if (affected.size > 0) {
      if (options?.useSyncLock !== false) {
        const shouldSync = tracks.some((t) => affected.has(t.id) && t.syncLocked !== false);
        if (shouldSync) {
          for (const t of tracks) {
            if (!t.locked && t.syncLocked !== false) affected.add(t.id);
          }
        }
      }
      return affected;
    }
  }

  if (targeted.size > 0) {
    const affected = new Set<string>();
    for (const id of targeted) {
      const tr = tracks.find((t) => t.id === id);
      if (tr && !tr.locked) affected.add(id);
    }
    if (options?.useSyncLock !== false) {
      const shouldSync = tracks.some((t) => affected.has(t.id) && t.syncLocked !== false);
      if (shouldSync) {
        for (const t of tracks) {
          if (!t.locked && t.syncLocked !== false) affected.add(t.id);
        }
      }
    }
    return affected;
  }

  const base = new Set(tracks.filter((t) => !t.locked).map((t) => t.id));
  if (options?.useSyncLock !== false) {
    const shouldSync = tracks.some((t) => base.has(t.id) && t.syncLocked !== false);
    if (shouldSync) {
      for (const t of tracks) {
        if (!t.locked && t.syncLocked !== false) base.add(t.id);
      }
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  mediaAssets: [],
  sequences: [],
  isLoading: false,
  error: null,
  _history: [],
  _future: [],

  // ---------------------------------------------------------------------------
  // Undo / Redo
  // ---------------------------------------------------------------------------

  _pushHistory: () => {
    const seq = get().sequences[0];
    if (!seq) return;
    const data = getSeqData(seq);
    const entry: HistoryEntry = {
      data: JSON.parse(JSON.stringify(data)),
      seqId: seq.id,
    };
    set((s) => ({
      _history: [...s._history.slice(-MAX_HISTORY), entry],
      _future: [], // Clear redo stack on new action
    }));
  },

  canUndo: () => get()._history.length > 0,
  canRedo: () => get()._future.length > 0,

  undo: async () => {
    const { _history, sequences } = get();
    if (_history.length === 0) return;
    const seq = sequences[0];
    if (!seq) return;

    const currentData = getSeqData(seq);
    const prev = _history[_history.length - 1];

    const futureEntry: HistoryEntry = {
      data: JSON.parse(JSON.stringify(currentData)),
      seqId: seq.id,
    };

    const restoredData = prev.data;

    set((s) => ({
      _history: s._history.slice(0, -1),
      _future: [...s._future, futureEntry],
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? { ...sq, data: restoredData as unknown as Record<string, unknown> } : sq,
      ),
    }));

    try {
      await enqueueSequenceUpdate(seq.id, {
        data: restoredData as unknown as Record<string, unknown>,
      });
    } catch (err) {
      console.warn('[projectStore] undo persist failed:', err);
    }
  },

  redo: async () => {
    const { _future, sequences } = get();
    if (_future.length === 0) return;
    const seq = sequences[0];
    if (!seq) return;

    const currentData = getSeqData(seq);
    const next = _future[_future.length - 1];

    const historyEntry: HistoryEntry = {
      data: JSON.parse(JSON.stringify(currentData)),
      seqId: seq.id,
    };

    const restoredData = next.data;

    set((s) => ({
      _future: s._future.slice(0, -1),
      _history: [...s._history, historyEntry],
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? { ...sq, data: restoredData as unknown as Record<string, unknown> } : sq,
      ),
    }));

    try {
      await enqueueSequenceUpdate(seq.id, {
        data: restoredData as unknown as Record<string, unknown>,
      });
    } catch (err) {
      console.warn('[projectStore] redo persist failed:', err);
    }
  },

  // ---------------------------------------------------------------------------
  // Project management (unchanged)
  // ---------------------------------------------------------------------------

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const projects = await api.projects.list();
      set({ projects, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  createProject: async (name: string, settings?: Record<string, unknown>) => {
    set({ isLoading: true, error: null });
    try {
      const project = await api.projects.create(name, settings);
      set((s) => ({ projects: [...s.projects, project], isLoading: false }));
      await get().openProject(project.id);
      return project;
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  openProject: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const project = await api.projects.get(id);
      const mediaAssets = await api.media.list(id);

      const migratedSequences: ApiSequence[] = [];
      for (const seq of project.sequences || []) {
        const current = getSeqData(seq);
        const ensured = ensureBaseTracks(current, seq.id);
        if (ensured.changed) {
          try {
            const updated = await enqueueSequenceUpdate(seq.id, {
              data: ensured.data as unknown as Record<string, unknown>,
            });
            migratedSequences.push(updated);
          } catch {
            migratedSequences.push({
              ...seq,
              data: ensured.data as unknown as Record<string, unknown>,
            });
          }
        } else {
          migratedSequences.push(seq);
        }
      }

      set({
        currentProject: project,
        mediaAssets,
        sequences: migratedSequences,
        isLoading: false,
        _history: [],
        _future: [],
      });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  closeProject: () => {
    set({
      currentProject: null,
      mediaAssets: [],
      sequences: [],
      _history: [],
      _future: [],
    });
  },

  deleteProject: async (id: string) => {
    try {
      await api.projects.delete(id);
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        currentProject: s.currentProject?.id === id ? null : s.currentProject,
        mediaAssets: s.currentProject?.id === id ? [] : s.mediaAssets,
        sequences: s.currentProject?.id === id ? [] : s.sequences,
      }));
      const refreshed = await api.projects.list();
      set({ projects: refreshed });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  updateProjectSettings: async (settings) => {
    const project = get().currentProject;
    if (!project) return;

    set({ isLoading: true, error: null });

    try {
      const updatedProject = await api.projects.update(project.id, { settings });

      let updatedSequences = get().sequences;
      const firstSeq = updatedSequences[0];
      if (firstSeq && (settings.defaultFrameRate || settings.defaultResolution)) {
        const updatedSeq = await enqueueSequenceUpdate(firstSeq.id, {
          frameRate: settings.defaultFrameRate,
          resolution: settings.defaultResolution,
        });
        updatedSequences = updatedSequences.map((sq) => (sq.id === firstSeq.id ? updatedSeq : sq));
      }

      set((s) => ({
        currentProject: updatedProject,
        projects: s.projects.map((p) => (p.id === updatedProject.id ? updatedProject : p)),
        sequences: updatedSequences,
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  importMedia: async (filePaths: string[]) => {
    const project = get().currentProject;
    if (!project) return;

    set({ isLoading: true, error: null });
    try {
      const result = await api.media.import(project.id, filePaths);
      set((s) => ({
        mediaAssets: mergeMediaAssets(s.mediaAssets, result.imported),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  pickMedia: async () => {
    const project = get().currentProject;
    if (!project) return [];

    set({ isLoading: true, error: null });
    try {
      const result = await api.media.pick(project.id);
      set((s) => ({
        mediaAssets: mergeMediaAssets(s.mediaAssets, result.imported),
        isLoading: false,
      }));
      if (result.errors.length > 0) {
        const errorNames = result.errors.map((e) => e.path).join(', ');
        set({ error: `Failed to link: ${errorNames}` });
      }
      return result.imported;
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      return [];
    }
  },

  uploadMedia: async (files: FileList | File[]) => {
    const project = get().currentProject;
    if (!project) return [];
    if (!files || (files instanceof FileList && files.length === 0)) return [];

    set({ isLoading: true, error: null });
    try {
      const fileList = Array.from(files as ArrayLike<File>);
      const linkedPaths = [...new Set(fileList.map(extractNativeFilePath).filter((value): value is string => !!value))];

      if (linkedPaths.length > 0) {
        const result = await api.media.import(project.id, linkedPaths);
        set((s) => ({
          mediaAssets: mergeMediaAssets(s.mediaAssets, result.imported),
          isLoading: false,
        }));
        if (linkedPaths.length !== fileList.length) {
          set({
            error:
              'Some files were skipped because this runtime did not expose native source paths. Use the Link Media button for fully linked imports.',
          });
        }
        return result.imported;
      }

      set({
        isLoading: false,
        error:
          'This runtime did not expose native source file paths, so files were not copied into the project. Use the Link Media button instead.',
      });
      return [];
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      return [];
    }
  },

  dedupeMedia: async () => {
    const project = get().currentProject;
    if (!project) return null;

    set({ isLoading: true, error: null });
    try {
      const [result, refreshedProject, refreshedMedia] = await Promise.all([
        api.media.dedupe(project.id),
        api.projects.get(project.id),
        api.media.list(project.id),
      ]);
      const { sequences = [], ...projectData } = refreshedProject;
      set({
        currentProject: projectData,
        sequences,
        mediaAssets: refreshedMedia,
        isLoading: false,
        _history: [],
        _future: [],
      });
      return result;
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      return null;
    }
  },

  deleteMedia: async (assetId: string) => {
    const project = get().currentProject;
    if (!project) return;

    try {
      const sequences = get().sequences;
      const updatedSequences: ApiSequence[] = [];

      for (const seq of sequences) {
        const data = getSeqData(seq);
        let changed = false;
        const updatedTracks = data.tracks.map((t) => {
          const nextClips = t.clips.filter((c) => c.mediaAssetId !== assetId);
          if (nextClips.length !== t.clips.length) changed = true;
          return changed ? { ...t, clips: nextClips } : t;
        });

        if (changed) {
          const updatedData = { ...data, tracks: updatedTracks };
          const updatedSeq = await enqueueSequenceUpdate(seq.id, {
            data: updatedData as Record<string, unknown>,
          });
          updatedSequences.push(updatedSeq);
        } else {
          updatedSequences.push(seq);
        }
      }

      await api.media.delete(project.id, assetId);
      set((s) => ({
        mediaAssets: s.mediaAssets.filter((a) => a.id !== assetId),
        sequences: updatedSequences,
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  // ---------------------------------------------------------------------------
  // Timeline editing
  // ---------------------------------------------------------------------------

  addTrack: async (type: 'video' | 'audio') => {
    const seq = get().sequences[0];
    if (!seq) return null;

    get()._pushHistory();

    const data = getSeqData(seq);
    const newTrack: TimelineTrackData = {
      id: generateId(),
      sequenceId: seq.id,
      name: nextTrackName(data.tracks, type),
      type,
      index: 0,
      locked: false,
      syncLocked: true,
      visible: true,
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      channelMode: 'stereo',
      channelMap: 'L+R',
      clips: [],
    };

    let tracks = [...data.tracks];
    if (type === 'video') {
      // Video tracks are ordered top-to-bottom by array order.
      // Insert new video tracks at the top (index 0).
      tracks.splice(0, 0, newTrack);
    } else {
      tracks.push(newTrack);
    }

    tracks = normalizeTrackIndices(tracks);
    const updatedData = { ...data, tracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
      return newTrack.id;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  addClipToTrack: async ({
    trackId,
    asset,
    startFrame,
    sourceInFrame,
    sourceOutFrame,
    insertMode,
    audioOnly,
  }) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);
    const effectiveType = audioOnly && asset.type === 'video' ? 'audio' : asset.type;
    const desiredTrackType = assetTypeToTrackType(effectiveType as ApiMediaAsset['type']);
    let track = data.tracks.find(
      (t) => t.id === trackId && t.type === desiredTrackType && !t.locked,
    );
    if (!track) {
      track = data.tracks.find((t) => t.type === desiredTrackType && !t.locked);
    }
    if (!track) return;

    const fps = seq.frameRate?.num ?? 24;
    const den = seq.frameRate?.den ?? 1;
    const fpsValue = fps / den;

    let clipInFrame = Math.max(0, sourceInFrame ?? 0);
    let clipOutFrame = sourceOutFrame ?? null;

    if (clipOutFrame == null) {
      let totalFrames = Math.round(fpsValue * 5);
      if (asset.duration != null && asset.duration > 0) {
        totalFrames = Math.round(asset.duration * fpsValue);
      }
      clipOutFrame = totalFrames;
    }

    if (clipOutFrame != null && clipOutFrame <= clipInFrame) {
      if (asset.duration != null && asset.duration > 0) {
        clipOutFrame = Math.round(asset.duration * fpsValue);
      } else {
        clipOutFrame = clipInFrame + Math.max(1, Math.round(fpsValue));
      }
    }

    const durationFrames = Math.max(1, (clipOutFrame ?? clipInFrame + 1) - clipInFrame);

    const newClipId = generateId();
    const newClip: TimelineClipData = {
      id: newClipId,
      name:
        effectiveType === 'audio' && asset.type === 'video' ? `${asset.name} (Audio)` : asset.name,
      type: effectiveType,
      startFrame,
      durationFrames,
      mediaAssetId: asset.id,
      sourceInFrame: clipInFrame,
      sourceOutFrame: clipInFrame + durationFrames,
      audioGainDb: 0,
      gain: 1,
      pan: 0,
      audioVolume: 1,
      audioPan: 0,
      blendMode: 'normal',
      blendParams: { silhouetteGamma: 1 },
      keyframes: [],
      transitionIn: null,
      transitionOut: null,
      masks: [],
      generator: null,
    };

    const updatedTracks = data.tracks.map((t) => {
      if (t.id !== track.id) return t;
      return {
        ...t,
        clips:
          insertMode === 'ripple'
            ? rippleInsertTrackWithClip(t.clips, newClip)
            : overwriteTrackWithClip(t.clips, newClip),
      };
    });

    if (asset.type === 'video' && !audioOnly) {
      const pairedAudioTrackId = findPairedAudioTrackId(updatedTracks, track.id);
      const audioTrack = pairedAudioTrackId
        ? updatedTracks.find((t) => t.id === pairedAudioTrackId)
        : null;
      if (audioTrack) {
        const audioClip: TimelineClipData = {
          ...newClip,
          id: generateId(),
          type: 'audio',
          name: `${asset.name} (Audio)`,
          linkedClipId: newClipId,
        };
        newClip.linkedClipId = audioClip.id;
        for (let i = 0; i < updatedTracks.length; i++) {
          if (updatedTracks[i].id === audioTrack.id) {
            updatedTracks[i] = {
              ...updatedTracks[i],
              clips:
                insertMode === 'ripple'
                  ? rippleInsertTrackWithClip(updatedTracks[i].clips, audioClip)
                  : overwriteTrackWithClip(updatedTracks[i].clips, audioClip),
            };
            break;
          }
        }
      }
    }
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  addGeneratorClip: async ({
    trackId,
    generator,
    name,
    startFrame,
    durationFrames = 120,
    insertMode = 'overwrite',
  }) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);
    let track = data.tracks.find((t) => t.id === trackId && t.type === 'video' && !t.locked);
    if (!track) {
      track = data.tracks.find((t) => t.type === 'video' && !t.locked);
    }
    if (!track) return;

    const clipName =
      name ??
      (generator.kind === 'black-video'
        ? 'Black Video'
        : generator.kind === 'color-matte'
          ? 'Color Matte'
          : 'Adjustment Layer');

    const newClip: TimelineClipData = {
      id: generateId(),
      name: clipName,
      type: 'video',
      startFrame: Math.max(0, Math.round(startFrame)),
      durationFrames: Math.max(1, Math.round(durationFrames)),
      mediaAssetId: null,
      sourceInFrame: 0,
      sourceOutFrame: Math.max(1, Math.round(durationFrames)),
      opacity: 1,
      positionX: 0,
      positionY: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      brightness: 1,
      contrast: 1,
      saturation: 1,
      hue: 0,
      vignette: 0,
      blendMode: 'normal',
      blendParams: { silhouetteGamma: 1 },
      keyframes: [],
      transitionIn: null,
      transitionOut: null,
      masks: [],
      generator,
    };

    const updatedTracks = data.tracks.map((t) => {
      if (t.id !== track.id) return t;
      return {
        ...t,
        clips:
          insertMode === 'ripple'
            ? rippleInsertTrackWithClip(t.clips, newClip)
            : overwriteTrackWithClip(t.clips, newClip),
      };
    });

    const updatedData = { ...data, tracks: updatedTracks };
    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  removeClips: async (clipIds: string[]) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);
    const clipIdSet = new Set(clipIds);

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => !clipIdSet.has(c.id)),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  moveClip: async (clipId, newTrackId, newStartFrame, options) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    let movedClip: TimelineClipData | null = null;
    let originalStartFrame = 0;
    const tracksWithout = data.tracks.map((t) => {
      const clip = t.clips.find((c) => c.id === clipId);
      if (clip) {
        originalStartFrame = clip.startFrame;
        movedClip = { ...clip, startFrame: Math.max(0, newStartFrame) };
        return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
      }
      return t;
    });

    if (!movedClip) return;

    const moved = movedClip as TimelineClipData;
    const desiredTrackType = clipTypeToTrackType(moved.type);
    let targetTrack = tracksWithout.find(
      (t) => t.id === newTrackId && t.type === desiredTrackType && !t.locked,
    );
    if (!targetTrack) {
      targetTrack = tracksWithout.find((t) => t.type === desiredTrackType && !t.locked);
    }
    if (!targetTrack) return;

    const updatedTracks = tracksWithout.map((t) => {
      if (t.id !== targetTrack.id) return t;
      return {
        ...t,
        clips: overwriteTrackWithClip(t.clips, moved, clipId),
      };
    });

    const delta = moved.startFrame - originalStartFrame;
    if (delta !== 0 && moved.linkedClipId && !options?.unlink) {
      for (let i = 0; i < updatedTracks.length; i++) {
        const tr = updatedTracks[i];
        if (tr.locked) continue;
        const linkedIndex = tr.clips.findIndex((c) => c.id === moved.linkedClipId);
        if (linkedIndex === -1) continue;
        const linked = tr.clips[linkedIndex];
        const nextStart = Math.max(0, linked.startFrame + delta);
        const updatedLinked = { ...linked, startFrame: nextStart };
        const others = tr.clips.filter((c) => c.id !== moved.linkedClipId);
        updatedTracks[i] = {
          ...tr,
          clips: overwriteTrackWithClip(others, updatedLinked, moved.linkedClipId),
        };
        break;
      }
    }
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  /**
   * Trim clip ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â adjusts startFrame, durationFrames, AND sourceIn/Out.
   *
   * Left trim (newStartFrame > old): sourceInFrame shifts forward.
   * Right trim (durationFrames changes): sourceOutFrame adjusts.
   */
  trimClip: async (clipId, newStartFrame, newDurationFrames, options) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    let targetClip: TimelineClipData | null = null;
    for (const track of data.tracks) {
      const c = track.clips.find((clip) => clip.id === clipId);
      if (c) {
        targetClip = c;
        break;
      }
    }
    if (!targetClip) return;

    const targetTrim = computeTrimResult(targetClip, newStartFrame, newDurationFrames);
    const deltaStart = targetTrim.startFrame - targetClip.startFrame;
    const deltaDuration = targetTrim.durationFrames - targetClip.durationFrames;
    const linkedId = !options?.unlink ? targetClip.linkedClipId : undefined;

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id === clipId) {
          return {
            ...c,
            startFrame: targetTrim.startFrame,
            durationFrames: targetTrim.durationFrames,
            sourceInFrame: targetTrim.sourceInFrame,
            sourceOutFrame: targetTrim.sourceOutFrame,
          };
        }

        if (linkedId && c.id === linkedId) {
          const linkedTrim = computeTrimResult(
            c,
            c.startFrame + deltaStart,
            c.durationFrames + deltaDuration,
          );
          return {
            ...c,
            startFrame: linkedTrim.startFrame,
            durationFrames: linkedTrim.durationFrames,
            sourceInFrame: linkedTrim.sourceInFrame,
            sourceOutFrame: linkedTrim.sourceOutFrame,
          };
        }

        return c;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  // ---------------------------------------------------------------------------
  // Milestone 2 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â new actions
  // ---------------------------------------------------------------------------

  /**
   * Split a clip at the playhead into two clips.
   * Correctly computes sourceInFrame/sourceOutFrame for both halves.
   */
  splitClipAtPlayhead: async (clipId: string, frame: number) => {
    const seq = get().sequences[0];
    if (!seq) return;

    const data = getSeqData(seq);

    // Find the clip and its track
    let foundClip: TimelineClipData | null = null;
    let foundTrackId: string | null = null;
    for (const track of data.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) {
        foundClip = clip;
        foundTrackId = track.id;
        break;
      }
    }
    if (!foundClip || !foundTrackId) return;

    // Validate: frame must be strictly inside the clip
    const clipEnd = foundClip.startFrame + foundClip.durationFrames;
    if (frame <= foundClip.startFrame || frame >= clipEnd) return;

    get()._pushHistory();

    const sourceIn = foundClip.sourceInFrame ?? 0;
    const localSplitFrame = frame - foundClip.startFrame;

    // Clip A: original start ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ split point
    const clipA: TimelineClipData = {
      ...foundClip,
      durationFrames: localSplitFrame,
      sourceOutFrame: sourceIn + localSplitFrame,
    };

    // Clip B: split point ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ original end
    const clipB: TimelineClipData = {
      ...foundClip,
      id: generateId(),
      name: foundClip.name + ' (2)',
      startFrame: frame,
      durationFrames: foundClip.durationFrames - localSplitFrame,
      sourceInFrame: sourceIn + localSplitFrame,
      sourceOutFrame: sourceIn + foundClip.durationFrames,
    };

    let linkedA: TimelineClipData | null = null;
    let linkedB: TimelineClipData | null = null;

    if (foundClip.linkedClipId) {
      let linkedClip: TimelineClipData | null = null;
      let linkedTrackId: string | null = null;
      for (const track of data.tracks) {
        const c = track.clips.find((x) => x.id === foundClip!.linkedClipId);
        if (c) {
          linkedClip = c;
          linkedTrackId = track.id;
          break;
        }
      }

      if (linkedClip && linkedTrackId) {
        const linkedLocalSplit = Math.min(
          Math.max(1, localSplitFrame),
          Math.max(1, linkedClip.durationFrames - 1),
        );
        const linkedFrame = linkedClip.startFrame + linkedLocalSplit;
        const lSourceIn = linkedClip.sourceInFrame ?? 0;

        linkedA = {
          ...linkedClip,
          durationFrames: linkedLocalSplit,
          sourceOutFrame: lSourceIn + linkedLocalSplit,
        };

        linkedB = {
          ...linkedClip,
          id: generateId(),
          name: linkedClip.name + ' (2)',
          startFrame: linkedFrame,
          durationFrames: linkedClip.durationFrames - linkedLocalSplit,
          sourceInFrame: lSourceIn + linkedLocalSplit,
          sourceOutFrame: lSourceIn + linkedClip.durationFrames,
        };

        // Keep pair links on the newly split clips
        clipA.linkedClipId = linkedA.id;
        clipB.linkedClipId = linkedB.id;
        linkedA.linkedClipId = clipA.id;
        linkedB.linkedClipId = clipB.id;
      }
    }

    const tId = foundTrackId;
    const updatedTracks = data.tracks.map((t) => {
      const hasPrimary = t.id === tId;
      const hasLinked = linkedA && linkedB ? t.clips.some((c) => c.id === linkedA!.id) : false;
      if (!hasPrimary && !hasLinked) return t;

      return {
        ...t,
        clips: t.clips.flatMap((c) => {
          if (hasPrimary && c.id === clipId) return [clipA, clipB];
          if (hasLinked && linkedA && linkedB && c.id === linkedA.id) return [linkedA, linkedB];
          return [c];
        }),
      };
    });
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  /**
   * Update arbitrary properties on a clip (transform, opacity, speed, etc.).
   */
  updateClipProperties: async (clipId: string, props: Partial<TimelineClipData>) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    let targetClip: TimelineClipData | null = null;
    for (const track of data.tracks) {
      const found = track.clips.find((c) => c.id === clipId);
      if (found) {
        targetClip = found;
        break;
      }
    }
    const linkedClipId = targetClip?.linkedClipId;

    const applySpeedChange = (
      c: TimelineClipData,
      requested: number,
      extra: Partial<TimelineClipData>,
    ): TimelineClipData => {
      const oldSpeedRaw = c.speed ?? 1;
      const oldSpeedAbs = Math.max(0.01, Math.abs(oldSpeedRaw));
      const sign = requested < 0 ? -1 : requested > 0 ? 1 : oldSpeedRaw < 0 ? -1 : 1;
      const nextSpeedAbs = Math.max(0.1, Math.abs(requested || oldSpeedRaw));
      const sourceIn = c.sourceInFrame ?? 0;
      const inferredOut = sourceIn + Math.max(1, Math.round(c.durationFrames * oldSpeedAbs));
      const sourceOut = c.sourceOutFrame ?? inferredOut;
      const sourceSpan = Math.max(1, sourceOut - sourceIn);
      const nextDuration = Math.max(1, Math.round(sourceSpan / nextSpeedAbs));

      return {
        ...c,
        ...extra,
        speed: sign * nextSpeedAbs,
        durationFrames: nextDuration,
        sourceInFrame: sourceIn,
        sourceOutFrame: sourceIn + sourceSpan,
      };
    };

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id === clipId) {
          if (props.speed === undefined) return { ...c, ...props };
          return applySpeedChange(c, Number(props.speed), props);
        }

        if (props.speed !== undefined && linkedClipId && c.id === linkedClipId) {
          return applySpeedChange(c, Number(props.speed), { speed: Number(props.speed) });
        }

        return c;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    // Optimistic local update to keep UI/audio responsive while dragging sliders.
    set((s) => ({
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? ({ ...sq, data: updatedData } as ApiSequence) : sq,
      ),
    }));

    const token = ++clipPropsMutationToken;

    try {
      await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      if (token !== clipPropsMutationToken) {
        // A newer slider update already replaced this state; ignore stale completion.
        return;
      }
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  upsertClipKeyframe: async (clipId: string, keyframe: TimelineKeyframeData) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    const normalized: TimelineKeyframeData = {
      ...keyframe,
      frame: Math.max(0, Math.round(keyframe.frame)),
    };

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const prev = c.keyframes ?? [];
        const filtered = prev.filter(
          (kf) => !(kf.id === normalized.id || (kf.property === normalized.property && kf.frame === normalized.frame)),
        );
        const keyframes = [...filtered, normalized].sort((a, b) => a.frame - b.frame);
        return { ...c, keyframes };
      }),
    }));

    const updatedData = { ...data, tracks: updatedTracks };

    // Optimistic update for responsive keyframe editing in Inspector/Graph.
    set((s) => ({
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? ({ ...sq, data: updatedData } as ApiSequence) : sq,
      ),
    }));

    const token = ++clipKeyframeMutationToken;

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      if (token !== clipKeyframeMutationToken) {
        return;
      }
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  removeClipKeyframe: async (clipId: string, keyframeId: string) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          keyframes: (c.keyframes ?? []).filter((kf) => kf.id !== keyframeId),
        };
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    // Optimistic update for responsive keyframe deletion in Inspector/Graph.
    set((s) => ({
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? ({ ...sq, data: updatedData } as ApiSequence) : sq,
      ),
    }));

    const token = ++clipKeyframeMutationToken;

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      if (token !== clipKeyframeMutationToken) {
        return;
      }
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setClipTransition: async (clipId: string, side: 'in' | 'out', transition: TransitionData | null) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);
    const fpsValue =
      (seq.frameRate?.num && seq.frameRate?.den ? seq.frameRate.num / seq.frameRate.den : 24) || 24;
    const mediaAssets = get().mediaAssets;

    const targetTrack = data.tracks.find((t) => t.clips.some((c) => c.id === clipId)) ?? null;
    const targetClip = targetTrack?.clips.find((c) => c.id === clipId) ?? null;
    if (!targetTrack || !targetClip) return;
    const existing = side === 'in' ? targetClip.transitionIn : targetClip.transitionOut;

    const normalized = transition
      ? {
          ...transition,
          durationFrames: Math.max(1, Math.round(transition.durationFrames)),
          type: normalizeTransitionType(transition.type),
          audioCrossfade:
            transition.audioCrossfade ??
            (normalizeTransitionType(transition.type) === 'cross-dissolve'),
        }
      : null;

    const limit = normalized
      ? computeTransitionSideLimit({
          track: targetTrack,
          clip: targetClip,
          side,
          type: normalized.type,
          requestedDurationFrames: normalized.durationFrames,
          mediaAssets,
          fps: fpsValue,
        })
      : null;

    const clamped = normalized
      ? {
          ...normalized,
          durationFrames: limit?.clampedDurationFrames ?? normalized.durationFrames,
        }
      : null;

    const linkedApply =
      clamped?.type === 'cross-dissolve' && limit?.neighborClipId && limit.neighborSide
        ? {
            clipId: limit.neighborClipId,
            side: limit.neighborSide,
          }
        : null;

    const linkedClear =
      !clamped &&
      existing?.type === 'cross-dissolve' &&
      (() => {
        const prevLimit = computeTransitionSideLimit({
          track: targetTrack,
          clip: targetClip,
          side,
          type: 'cross-dissolve',
          requestedDurationFrames: existing.durationFrames,
          mediaAssets,
          fps: fpsValue,
        });
        if (!prevLimit.neighborClipId || !prevLimit.neighborSide) return null;
        return {
          clipId: prevLimit.neighborClipId,
          side: prevLimit.neighborSide,
        };
      })();

    const linkedCurrent =
      linkedApply &&
      data.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === linkedApply.clipId);
    const linkedTransition =
      linkedApply && clamped
        ? {
            id:
              (linkedApply.side === 'in'
                ? linkedCurrent?.transitionIn?.id
                : linkedCurrent?.transitionOut?.id) ?? generateId(),
            type: 'cross-dissolve' as const,
            durationFrames: clamped.durationFrames,
            audioCrossfade: clamped.audioCrossfade ?? true,
          }
        : null;

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        let next = c;
        if (c.id === clipId) {
          next =
            side === 'in'
              ? { ...next, transitionIn: clamped }
              : { ...next, transitionOut: clamped };
        }

        if (linkedApply && linkedTransition && c.id === linkedApply.clipId) {
          next =
            linkedApply.side === 'in'
              ? { ...next, transitionIn: linkedTransition }
              : { ...next, transitionOut: linkedTransition };
        } else if (linkedClear && c.id === linkedClear.clipId) {
          const linkedExisting =
            linkedClear.side === 'in' ? next.transitionIn : next.transitionOut;
          if (linkedExisting?.type === 'cross-dissolve') {
            next =
              linkedClear.side === 'in'
                ? { ...next, transitionIn: null }
                : { ...next, transitionOut: null };
          }
        }

        return next;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  addClipMask: async (clipId: string, mask: ManualMaskData) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    const normalizedIncoming = normalizeMasks([mask])[0];
    if (!normalizedIncoming) return;

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const masks = [...(c.masks ?? []), normalizedIncoming];
        return { ...c, masks };
      }),
    }));

    const updatedData = { ...data, tracks: updatedTracks };
    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  updateClipMask: async (
    clipId: string,
    maskId: string,
    patch: Partial<Omit<ManualMaskData, 'id'>>,
  ) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const masks = (c.masks ?? []).map((m) => {
          if (m.id !== maskId) return m;
          const merged: ManualMaskData = {
            ...m,
            ...patch,
            id: m.id,
            keyframes:
              patch.keyframes != null
                ? patch.keyframes.map((kf) => ({
                    ...kf,
                    frame: Math.max(0, Math.round(kf.frame)),
                    points: kf.points.map((p) => ({
                      x: p.x,
                      y: p.y,
                      inX: p.inX,
                      inY: p.inY,
                      outX: p.outX,
                      outY: p.outY,
                    })),
                  }))
                : m.keyframes,
          };
          return normalizeMasks([merged])[0] ?? merged;
        });
        return { ...c, masks };
      }),
    }));

    const updatedData = { ...data, tracks: updatedTracks };
    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  removeClipMask: async (clipId: string, maskId: string) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        return { ...c, masks: (c.masks ?? []).filter((m) => m.id !== maskId) };
      }),
    }));

    const updatedData = { ...data, tracks: updatedTracks };
    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  upsertMaskShapeKeyframe: async (clipId: string, maskId: string, keyframe: MaskShapeKeyframe) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    const normalizedKeyframe: MaskShapeKeyframe = {
      ...keyframe,
      frame: Math.max(0, Math.round(keyframe.frame)),
      points: keyframe.points.map((p) => ({
        x: p.x,
        y: p.y,
        inX: p.inX,
        inY: p.inY,
        outX: p.outX,
        outY: p.outY,
      })),
    };

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const masks = (c.masks ?? []).map((m) => {
          if (m.id !== maskId) return m;
          const prev = m.keyframes ?? [];
          const filtered = prev.filter(
            (kf) => !(kf.id === normalizedKeyframe.id || kf.frame === normalizedKeyframe.frame),
          );
          const keyframes = [...filtered, normalizedKeyframe].sort((a, b) => a.frame - b.frame);
          return { ...m, keyframes };
        });
        return { ...c, masks };
      }),
    }));

    const updatedData = { ...data, tracks: updatedTracks };
    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  removeMaskShapeKeyframe: async (clipId: string, maskId: string, keyframeId: string) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const masks = (c.masks ?? []).map((m) => {
          if (m.id !== maskId) return m;
          return {
            ...m,
            keyframes: (m.keyframes ?? []).filter((kf) => kf.id !== keyframeId),
          };
        });
        return { ...c, masks };
      }),
    }));

    const updatedData = { ...data, tracks: updatedTracks };
    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  insertMaskPointAcrossKeyframes: async (
    clipId: string,
    maskId: string,
    params: { frame: number; insertAt: number; point?: MaskPoint },
  ) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);
    const targetFrame = Math.max(0, Math.round(params.frame));
    const insertAtIndex = Math.max(0, Math.round(params.insertAt));
    const explicitPoint = params.point ? cloneMaskPoint(params.point) : null;
    let changed = false;

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const masks = (c.masks ?? []).map((m) => {
          if (m.id !== maskId) return m;
          const keyframes = (m.keyframes ?? []).map((kf) => {
            const points = (kf.points ?? []).map(cloneMaskPoint);
            if (points.length === 0 && !explicitPoint) return kf;
            const clampedInsertAt = Math.max(0, Math.min(points.length, insertAtIndex));
            const inserted =
              kf.frame === targetFrame && explicitPoint
                ? cloneMaskPoint(explicitPoint)
                : fallbackInsertedMaskPoint(points, clampedInsertAt);
            const nextPoints = [...points];
            nextPoints.splice(clampedInsertAt, 0, inserted);
            changed = true;
            return { ...kf, points: nextPoints };
          });
          return { ...m, keyframes };
        });
        return { ...c, masks };
      }),
    }));

    if (!changed) return;

    const updatedData = { ...data, tracks: updatedTracks };
    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  removeMaskPointAcrossKeyframes: async (clipId: string, maskId: string, pointIndex: number) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();
    const data = getSeqData(seq);
    const requestedIndex = Math.max(0, Math.round(pointIndex));
    let changed = false;

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const masks = (c.masks ?? []).map((m) => {
          if (m.id !== maskId) return m;
          const keyframes = (m.keyframes ?? []).map((kf) => {
            const points = (kf.points ?? []).map(cloneMaskPoint);
            if (points.length <= 2) return kf;
            const idx = Math.max(0, Math.min(points.length - 1, requestedIndex));
            points.splice(idx, 1);
            changed = true;
            return { ...kf, points };
          });
          return { ...m, keyframes };
        });
        return { ...c, masks };
      }),
    }));

    if (!changed) return;

    const updatedData = { ...data, tracks: updatedTracks };
    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  /**
   * Ripple trim: trims a clip AND shifts all subsequent clips on the same
   * track to close or open the gap.
   */
  rippleTrimClip: async (
    clipId: string,
    newStartFrame: number,
    newDurationFrames: number,
    options,
  ) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    let targetClip: TimelineClipData | null = null;
    for (const track of data.tracks) {
      const c = track.clips.find((clip) => clip.id === clipId);
      if (c) {
        targetClip = c;
        break;
      }
    }
    if (!targetClip) return;

    const targetTrim = computeTrimResult(targetClip, newStartFrame, newDurationFrames);
    const deltaStart = targetTrim.startFrame - targetClip.startFrame;
    const deltaDuration = targetTrim.durationFrames - targetClip.durationFrames;
    const linkedId = !options?.unlink ? targetClip.linkedClipId : undefined;

    const updatedTracks = data.tracks.map((t) => {
      const target = t.clips.find((c) => c.id === clipId);
      const linked = linkedId ? t.clips.find((c) => c.id === linkedId) : undefined;
      if (!target && !linked) return t;

      const activeClip = target ?? linked!;
      const trim = target
        ? targetTrim
        : computeTrimResult(
            activeClip,
            activeClip.startFrame + deltaStart,
            activeClip.durationFrames + deltaDuration,
          );

      const rippleDelta = trim.newEnd - trim.oldEnd;

      return {
        ...t,
        clips: t.clips.map((c) => {
          if (c.id === activeClip.id) {
            return {
              ...c,
              startFrame: trim.startFrame,
              durationFrames: trim.durationFrames,
              sourceInFrame: trim.sourceInFrame,
              sourceOutFrame: trim.sourceOutFrame,
            };
          }
          if (c.startFrame >= trim.oldEnd) {
            return { ...c, startFrame: Math.max(0, c.startFrame + rippleDelta) };
          }
          return c;
        }),
      };
    });
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  /**
   * Ripple delete: removes clips AND shifts subsequent clips on each track
   * to fill the gap.
   */
  rippleDeleteClips: async (clipIds: string[]) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);
    const clipIdSet = new Set(clipIds);

    const updatedTracks = data.tracks.map((t) => {
      const deletedOnTrack = t.clips
        .filter((c) => clipIdSet.has(c.id))
        .sort((a, b) => a.startFrame - b.startFrame);

      if (deletedOnTrack.length === 0) {
        return { ...t, clips: t.clips.filter((c) => !clipIdSet.has(c.id)) };
      }

      const remaining = t.clips.filter((c) => !clipIdSet.has(c.id));
      const shifted = remaining.map((c) => {
        let totalShift = 0;
        for (const del of deletedOnTrack) {
          if (del.startFrame + del.durationFrames <= c.startFrame) {
            totalShift += del.durationFrames;
          }
        }
        return totalShift > 0 ? { ...c, startFrame: Math.max(0, c.startFrame - totalShift) } : c;
      });

      return { ...t, clips: shifted };
    });
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  liftRangeByInOut: async (inFrame: number, outFrame: number, options) => {
    const seq = get().sequences[0];
    if (!seq) return;

    const rangeIn = Math.max(0, Math.min(inFrame, outFrame));
    const rangeOut = Math.max(rangeIn + 1, Math.max(inFrame, outFrame));

    get()._pushHistory();

    const data = getSeqData(seq);
    const affectedTrackIds = resolveAffectedTrackIds(data.tracks, options);

    const updatedTracks = data.tracks.map((t) => {
      if (t.locked || !affectedTrackIds.has(t.id)) return t;
      const clips = t.clips.flatMap((clip) => cutClipByRange(clip, rangeIn, rangeOut, 'lift'));
      clips.sort((a, b) => a.startFrame - b.startFrame);
      return { ...t, clips };
    });

    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  extractRangeByInOut: async (inFrame: number, outFrame: number, options) => {
    const seq = get().sequences[0];
    if (!seq) return;

    const rangeIn = Math.max(0, Math.min(inFrame, outFrame));
    const rangeOut = Math.max(rangeIn + 1, Math.max(inFrame, outFrame));

    get()._pushHistory();

    const data = getSeqData(seq);
    const affectedTrackIds = resolveAffectedTrackIds(data.tracks, options);

    const updatedTracks = data.tracks.map((t) => {
      if (t.locked || !affectedTrackIds.has(t.id)) return t;
      const clips = t.clips.flatMap((clip) => cutClipByRange(clip, rangeIn, rangeOut, 'extract'));
      clips.sort((a, b) => a.startFrame - b.startFrame);
      return { ...t, clips };
    });

    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  // ---------------------------------------------------------------------------
  // Milestone 3 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â track management
  // ---------------------------------------------------------------------------

  updateTrack: async (trackId: string, props) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    const updatedTracks = data.tracks.map((t) => (t.id === trackId ? { ...t, ...props } : t));
    const updatedData = { ...data, tracks: updatedTracks };

    // Optimistic update
    set((s) => ({
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? { ...sq, data: updatedData as unknown as Record<string, unknown> } : sq,
      ),
    }));

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      console.warn('[projectStore] updateTrack persist failed:', err);
    }
  },

  isTrackLocked: (trackId: string) => {
    const seq = get().sequences[0];
    if (!seq) return false;
    const data = getSeqData(seq);
    const track = data.tracks.find((t) => t.id === trackId);
    return track?.locked ?? false;
  },

  unlinkSelectedClips: async (clipIds: string[]) => {
    const seq = get().sequences[0];
    if (!seq || clipIds.length === 0) return;

    get()._pushHistory();

    const idSet = new Set(clipIds);
    const data = getSeqData(seq);

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (idSet.has(c.id)) {
          return { ...c, linkedClipId: undefined };
        }
        if (c.linkedClipId && idSet.has(c.linkedClipId)) {
          return { ...c, linkedClipId: undefined };
        }
        return c;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  relinkSelectedClips: async (clipIds: string[]) => {
    const seq = get().sequences[0];
    if (!seq || clipIds.length < 2) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    type ClipWithTrack = { clip: TimelineClipData; trackType: 'video' | 'audio' };
    const selected: ClipWithTrack[] = [];
    const idSet = new Set(clipIds);
    for (const t of data.tracks) {
      for (const c of t.clips) {
        if (idSet.has(c.id)) {
          const trackType: 'video' | 'audio' = c.type === 'audio' ? 'audio' : 'video';
          selected.push({ clip: c, trackType });
        }
      }
    }

    if (selected.length < 2) return;

    const linkMap = new Map<string, string | undefined>();
    for (const { clip } of selected) {
      linkMap.set(clip.id, undefined);
    }

    const videos = selected.filter((x) => x.trackType === 'video').map((x) => x.clip);
    const audios = selected.filter((x) => x.trackType === 'audio').map((x) => x.clip);

    const usedAudio = new Set<string>();

    const scorePair = (v: TimelineClipData, a: TimelineClipData): number => {
      const vS = v.startFrame;
      const vE = v.startFrame + v.durationFrames;
      const aS = a.startFrame;
      const aE = a.startFrame + a.durationFrames;
      const overlap = Math.max(0, Math.min(vE, aE) - Math.max(vS, aS));
      const centerDist = Math.abs((vS + vE) / 2 - (aS + aE) / 2);
      return overlap * 1000 - centerDist;
    };

    for (const v of videos) {
      let best: TimelineClipData | null = null;
      let bestScore = -Infinity;
      for (const a of audios) {
        if (usedAudio.has(a.id)) continue;
        const s = scorePair(v, a);
        if (s > bestScore) {
          bestScore = s;
          best = a;
        }
      }
      if (best) {
        usedAudio.add(best.id);
        linkMap.set(v.id, best.id);
        linkMap.set(best.id, v.id);
      }
    }

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (idSet.has(c.id)) {
          return { ...c, linkedClipId: linkMap.get(c.id) };
        }
        // Remove stale links that point into relinked set
        if (c.linkedClipId && idSet.has(c.linkedClipId)) {
          return { ...c, linkedClipId: undefined };
        }
        return c;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setError: (error: string | null) => set({ error }),
}));
