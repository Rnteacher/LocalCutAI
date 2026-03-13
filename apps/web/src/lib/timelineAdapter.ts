/**
 * Timeline Model Adapter - converts the store's flat timeline model into
 * canonical @localcut/core sequence types.
 */

import type {
  FrameRate,
  Resolution,
  TimeValue,
  Sequence,
  Track,
  ClipItem,
  TransformState,
  BlendMode,
  TransitionData,
  TransitionType,
  ClipBlendParams,
  ManualMaskData,
  GeneratorData,
  Keyframe,
} from './core.js';
import type { TimelineTrackData, TimelineClipData } from '../stores/projectStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function framesToTimeValue(frames: number, rate: FrameRate): TimeValue {
  return { frames: Math.max(0, Math.round(frames)), rate };
}

const DEFAULT_TRANSFORM: TransformState = {
  positionX: 0,
  positionY: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
};

function normalizeBlendMode(mode: TimelineClipData['blendMode']): BlendMode {
  if (
    mode === 'normal' ||
    mode === 'multiply' ||
    mode === 'screen' ||
    mode === 'overlay' ||
    mode === 'add' ||
    mode === 'silhouette-alpha' ||
    mode === 'silhouette-luma'
  ) {
    return mode;
  }
  return 'normal';
}

function normalizeTransitionType(type: unknown): TransitionType {
  if (type === 'cross-dissolve' || type === 'fade-black') {
    return type;
  }
  if (type === 'dissolve' || type === 'wipe-left' || type === 'wipe-right') {
    return 'cross-dissolve';
  }
  return 'cross-dissolve';
}

function adaptTransition(
  transition: TimelineClipData['transitionIn'],
  rate: FrameRate,
): TransitionData | null {
  if (!transition) return null;
  const durationFrames = Math.max(1, Math.round(transition.durationFrames ?? 0));
  if (!Number.isFinite(durationFrames) || durationFrames <= 0) {
    return null;
  }
  return {
    id: transition.id,
    type: normalizeTransitionType(transition.type),
    duration: framesToTimeValue(durationFrames, rate),
    audioCrossfade: transition.audioCrossfade,
  };
}

function adaptKeyframes(clip: TimelineClipData, rate: FrameRate): Keyframe[] {
  if (!clip.keyframes || clip.keyframes.length === 0) return [];
  return clip.keyframes.map((kf) => ({
    id: kf.id,
    clipId: clip.id,
    property: kf.property,
    time: framesToTimeValue(kf.frame, rate),
    value: kf.value,
    easing: kf.easing,
    bezierHandles: kf.bezierHandles,
  }));
}

function adaptMasks(masks: TimelineClipData['masks']): ManualMaskData[] {
  if (!masks || masks.length === 0) return [];
  return masks.map((mask) => ({
    ...mask,
    keyframes: mask.keyframes.map((kf) => ({
      ...kf,
      points: kf.points.map((p) => ({ ...p })),
    })),
  }));
}

function adaptGenerator(generator: TimelineClipData['generator']): GeneratorData | null {
  if (!generator) return null;
  if (
    generator.kind !== 'black-video' &&
    generator.kind !== 'color-matte' &&
    generator.kind !== 'adjustment-layer'
  ) {
    return null;
  }
  if (generator.kind === 'color-matte') {
    return {
      kind: 'color-matte',
      color: generator.color ?? '#000000',
    };
  }
  return { kind: generator.kind };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Convert a flat `TimelineClipData` to a full `ClipItem` that the core
 * engine can process.
 */
function adaptClip(clip: TimelineClipData, trackId: string, rate: FrameRate): ClipItem {
  const sourceIn = clip.sourceInFrame ?? 0;
  const sourceOut = clip.sourceOutFrame ?? sourceIn + clip.durationFrames;

  return {
    id: clip.id,
    trackId,
    mediaAssetId: clip.mediaAssetId ?? null,
    type:
      clip.type === 'video' || clip.type === 'audio' || clip.type === 'image' ? clip.type : 'gap',
    name: clip.name,

    // Timeline position
    startTime: framesToTimeValue(clip.startFrame, rate),
    duration: framesToTimeValue(clip.durationFrames, rate),

    // Source range
    sourceInPoint: framesToTimeValue(sourceIn, rate),
    sourceOutPoint: framesToTimeValue(sourceOut, rate),

    // Audio base values (custom audio controls are applied in web audio engine)
    volume: 1,
    pan: 0,
    audioEnvelope: [],
    speed: clip.speed ?? 1,

    // Transform - use clip values with defaults
    transform: {
      positionX: clip.positionX ?? DEFAULT_TRANSFORM.positionX,
      positionY: clip.positionY ?? DEFAULT_TRANSFORM.positionY,
      scaleX: clip.scaleX ?? DEFAULT_TRANSFORM.scaleX,
      scaleY: clip.scaleY ?? DEFAULT_TRANSFORM.scaleY,
      rotation: clip.rotation ?? DEFAULT_TRANSFORM.rotation,
      anchorX: DEFAULT_TRANSFORM.anchorX,
      anchorY: DEFAULT_TRANSFORM.anchorY,
    },

    // Visual
    opacity: clip.opacity ?? 1,
    brightness: clip.brightness ?? 1,
    contrast: clip.contrast ?? 1,
    saturation: clip.saturation ?? 1,
    hue: clip.hue ?? 0,
    vignette: clip.vignette ?? 0,
    blendMode: normalizeBlendMode(clip.blendMode),
    blendParams: {
      silhouetteGamma: (clip.blendParams as ClipBlendParams | undefined)?.silhouetteGamma ?? 1,
    },

    keyframes: adaptKeyframes(clip, rate),
    transitionIn: adaptTransition(clip.transitionIn, rate),
    transitionOut: adaptTransition(clip.transitionOut, rate),
    masks: adaptMasks(clip.masks),
    generator: adaptGenerator(clip.generator),
    disabled: false,
  };
}

/**
 * Convert a flat `TimelineTrackData` to a full `Track`.
 */
function adaptTrack(track: TimelineTrackData, rate: FrameRate): Track {
  return {
    id: track.id,
    sequenceId: track.sequenceId,
    name: track.name,
    type: track.type,
    index: track.index,
    locked: track.locked,
    visible: track.visible,
    muted: track.muted,
    solo: track.solo,
    volume: track.volume,
    pan: track.pan,
    clips: track.clips.map((c) => adaptClip(c, track.id, rate)),
  };
}

/**
 * Convert flat sequence data (as stored in SQLite / projectStore) into a
 * full `Sequence` that can be passed to `buildCompositionPlan()`.
 */
export function adaptSequence(
  seqId: string,
  projectId: string,
  name: string,
  tracks: TimelineTrackData[],
  frameRate: FrameRate,
  resolution: Resolution,
): Sequence {
  const coreTracks = tracks.map((t) => adaptTrack(t, frameRate));

  let maxFrame = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      const end = clip.startFrame + clip.durationFrames;
      if (end > maxFrame) maxFrame = end;
    }
  }

  return {
    id: seqId,
    projectId,
    name,
    frameRate,
    resolution,
    duration: framesToTimeValue(maxFrame, frameRate),
    tracks: coreTracks,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * Get the effective FPS value from a FrameRate.
 */
export function getEffectiveFps(frameRate: FrameRate | null | undefined): number {
  if (!frameRate) return 30;
  const { num, den } = frameRate;
  if (!num || !den) return 30;
  return num / den;
}
