/**
 * @module compositionPlan
 *
 * Builds the per-frame rendering instructions from the current timeline state.
 *
 * A {@link CompositionPlan} describes everything the renderer needs to produce
 * a single output frame (or audio sample window): which media sources to
 * decode, how to composite video layers, and how to mix audio sources.
 *
 * The plan is intentionally a *data-only* description so that it can be
 * consumed by any renderer backend (Canvas 2D, WebGL, OffscreenCanvas, or a
 * server-side FFmpeg pipeline for export).
 */

import type { ID, Resolution, TimeValue } from '../types/project.js';
import type {
  BlendMode,
  Sequence,
  TransformState,
  TransitionType,
} from '../types/timeline.js';
import { resolveActiveClips } from './timeResolver.js';
import { getPropertyValue } from './keyframeEval.js';
import { computeClipGain, computeStereoPan, computeTrackGain, resolveAudibleTrackIds } from './audioMix.js';
import { timeValueToSeconds, addTimeValues } from '../utils/timecode.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Describes a single video layer to be composited in bottom-to-top order.
 */
export interface VideoLayer {
  clipId: ID;
  trackId: ID;
  mediaAssetId: ID | null;
  /** Time in the source media file to decode. */
  sourceTime: TimeValue;
  /** Fully resolved transform (after keyframe evaluation). */
  transform: TransformState;
  /** Fully resolved opacity (after keyframe evaluation), clamped to [0, 1]. */
  opacity: number;
  blendMode: BlendMode;
  /**
   * Progress through a transition in [0, 1], or `null` if no transition is
   * active for this clip at this time.
   */
  transitionProgress: number | null;
  transitionType: TransitionType | null;
}

/**
 * Describes a single audio source contributing to the mix at this frame.
 */
export interface AudioSource {
  clipId: ID;
  trackId: ID;
  mediaAssetId: ID | null;
  /** Time in the source media file to read. */
  sourceTime: TimeValue;
  /** Final computed gain (clip × envelope × track). */
  gain: number;
  /** Stereo pan coefficients. */
  pan: { left: number; right: number };
}

/**
 * Complete rendering instructions for a single frame of the composition.
 */
export interface CompositionPlan {
  sequenceId: ID;
  time: TimeValue;
  resolution: Resolution;
  /** Video layers in bottom-to-top compositing order. */
  videoLayers: VideoLayer[];
  /** Audio sources to be mixed together. */
  audioSources: AudioSource[];
}

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

/**
 * Compute the transition progress for a clip at the given local time.
 *
 * - **transitionIn**: the first `transition.duration` frames of the clip.
 * - **transitionOut**: the last `transition.duration` frames of the clip.
 *
 * If neither transition is active at `localTime`, returns `null`.
 */
function resolveTransition(
  clip: ReturnType<typeof resolveActiveClips>[number]['clip'],
  localTimeSec: number,
): { progress: number; type: TransitionType } | null {
  const durationSec = timeValueToSeconds(clip.duration);

  // Transition in.
  if (clip.transitionIn) {
    const tDur = timeValueToSeconds(clip.transitionIn.duration);
    if (localTimeSec < tDur && tDur > 0) {
      return {
        progress: localTimeSec / tDur,
        type: clip.transitionIn.type,
      };
    }
  }

  // Transition out.
  if (clip.transitionOut) {
    const tDur = timeValueToSeconds(clip.transitionOut.duration);
    const outStart = durationSec - tDur;
    if (localTimeSec >= outStart && tDur > 0) {
      return {
        progress: (localTimeSec - outStart) / tDur,
        type: clip.transitionOut.type,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

/**
 * Build the complete composition plan for a single frame at the given
 * playhead time.
 *
 * @param sequence     - The sequence to evaluate.
 * @param playheadTime - The current playhead position.
 * @returns A {@link CompositionPlan} that the renderer can execute.
 */
export function buildCompositionPlan(
  sequence: Sequence,
  playheadTime: TimeValue,
): CompositionPlan {
  const activeClips = resolveActiveClips(sequence, playheadTime);
  const audibleIds = resolveAudibleTrackIds(sequence.tracks);

  const videoLayers: VideoLayer[] = [];
  const audioSources: AudioSource[] = [];

  for (const ac of activeClips) {
    const { clip, track, clipLocalTime, sourceTime } = ac;
    const localTimeSec = timeValueToSeconds(clipLocalTime);

    // ----- Video / image layers -------------------------------------------
    if (clip.type === 'video' || clip.type === 'image') {
      // Evaluate all animatable transform properties.
      const transform: TransformState = {
        positionX: getPropertyValue(clip, 'transform.positionX', clipLocalTime),
        positionY: getPropertyValue(clip, 'transform.positionY', clipLocalTime),
        scaleX: getPropertyValue(clip, 'transform.scaleX', clipLocalTime),
        scaleY: getPropertyValue(clip, 'transform.scaleY', clipLocalTime),
        rotation: getPropertyValue(clip, 'transform.rotation', clipLocalTime),
        anchorX: clip.transform.anchorX,
        anchorY: clip.transform.anchorY,
      };

      const opacity = Math.max(
        0,
        Math.min(1, getPropertyValue(clip, 'opacity', clipLocalTime)),
      );

      const transition = resolveTransition(clip, localTimeSec);

      videoLayers.push({
        clipId: clip.id,
        trackId: track.id,
        mediaAssetId: clip.mediaAssetId,
        sourceTime,
        transform,
        opacity,
        blendMode: clip.blendMode,
        transitionProgress: transition?.progress ?? null,
        transitionType: transition?.type ?? null,
      });
    }

    // ----- Audio sources --------------------------------------------------
    if (
      (clip.type === 'video' || clip.type === 'audio') &&
      audibleIds.has(track.id)
    ) {
      const clipGain = computeClipGain(clip, clipLocalTime);
      const trackGain = computeTrackGain(track);
      const gain = clipGain * trackGain;

      const kfPan = getPropertyValue(clip, 'pan', clipLocalTime);
      const pan = computeStereoPan(kfPan, track.pan);

      audioSources.push({
        clipId: clip.id,
        trackId: track.id,
        mediaAssetId: clip.mediaAssetId,
        sourceTime,
        gain,
        pan,
      });
    }
  }

  // Video layers must be in bottom-to-top order.
  // The sequence tracks are ordered top-to-bottom (V3, V2, V1, …), so the
  // *last* video track in the array is the bottom layer.  We reverse to get
  // bottom-to-top compositing order.
  videoLayers.reverse();

  return {
    sequenceId: sequence.id,
    time: playheadTime,
    resolution: sequence.resolution,
    videoLayers,
    audioSources,
  };
}
