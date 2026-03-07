/**
 * Timeline Model Adapter — converts the store's flat timeline model into
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

    // Transform — use clip values with defaults
    transform: {
      positionX: clip.positionX ?? DEFAULT_TRANSFORM.positionX,
      positionY: clip.positionY ?? DEFAULT_TRANSFORM.positionY,
      scaleX: clip.scaleX ?? DEFAULT_TRANSFORM.scaleX,
      scaleY: clip.scaleY ?? DEFAULT_TRANSFORM.scaleY,
      rotation: clip.rotation ?? DEFAULT_TRANSFORM.rotation,
      anchorX: DEFAULT_TRANSFORM.anchorX,
      anchorY: DEFAULT_TRANSFORM.anchorY,
    },

    // Visual — use clip value with default
    opacity: clip.opacity ?? 1,
    blendMode: 'normal',

    // No keyframes/transitions from the store yet
    keyframes: [],
    transitionIn: null,
    transitionOut: null,

    masks: [],
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
 *
 * @param seqId     - The sequence ID.
 * @param tracks    - Flat track data from projectStore.
 * @param frameRate - The sequence's frame rate.
 * @param resolution - The sequence's resolution.
 * @returns A fully typed `Sequence` compatible with the core engine.
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

  // Compute total duration as end of last clip
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
