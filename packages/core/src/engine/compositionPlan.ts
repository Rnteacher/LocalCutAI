/**
 * @module compositionPlan
 *
 * Builds per-frame rendering instructions from timeline state.
 */

import type { ID, Resolution, TimeValue } from '../types/project.js';
import type {
  BlendMode,
  ClipItem,
  Sequence,
  Track,
  TransformState,
  TransitionType,
} from '../types/timeline.js';
import { resolveActiveClips } from './timeResolver.js';
import { getPropertyValue } from './keyframeEval.js';
import { computeClipGain, computeStereoPan, computeTrackGain, resolveAudibleTrackIds } from './audioMix.js';
import { timeValueToSeconds } from '../utils/timecode.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VideoLayer {
  clipId: ID;
  trackId: ID;
  mediaAssetId: ID | null;
  sourceTime: TimeValue;
  transform: TransformState;
  opacity: number;
  blendMode: BlendMode;
  generator: ReturnType<typeof resolveActiveClips>[number]['clip']['generator'];
  transitionProgress: number | null;
  transitionType: TransitionType | null;
  transitionPhase: 'in' | 'out' | null;
  transitionAudioCrossfade: boolean;
}

export interface AudioSource {
  clipId: ID;
  trackId: ID;
  mediaAssetId: ID | null;
  sourceTime: TimeValue;
  gain: number;
  pan: { left: number; right: number };
  transitionProgress: number | null;
  transitionType: TransitionType | null;
  transitionPhase: 'in' | 'out' | null;
  transitionAudioCrossfade: boolean;
}

export interface CompositionPlan {
  sequenceId: ID;
  time: TimeValue;
  resolution: Resolution;
  videoLayers: VideoLayer[];
  audioSources: AudioSource[];
}

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

interface TransitionSpec {
  progress: number;
  type: TransitionType;
  phase: 'in' | 'out';
  audioCrossfade: boolean;
}

interface CenteredDissolvePair {
  track: Track;
  outgoing: ClipItem;
  incoming: ClipItem;
  cutFrame: number;
  progress: number;
  audioCrossfade: boolean;
}

function normalizeTransitionType(type: string): TransitionType {
  if (type === 'cross-dissolve' || type === 'fade-black') return type;
  if (type === 'dissolve') return 'cross-dissolve';
  if (type === 'wipe-left' || type === 'wipe-right') return 'cross-dissolve';
  return 'cross-dissolve';
}

function resolveTransition(
  clip: ClipItem,
  localTimeSec: number,
): TransitionSpec | null {
  const durationSec = timeValueToSeconds(clip.duration);

  if (clip.transitionIn) {
    const tDur = timeValueToSeconds(clip.transitionIn.duration);
    if (localTimeSec < tDur && tDur > 0) {
      return {
        progress: localTimeSec / tDur,
        type: normalizeTransitionType(clip.transitionIn.type),
        phase: 'in',
        audioCrossfade: clip.transitionIn.audioCrossfade ?? true,
      };
    }
  }

  if (clip.transitionOut) {
    const tDur = timeValueToSeconds(clip.transitionOut.duration);
    const outStart = durationSec - tDur;
    if (localTimeSec >= outStart && tDur > 0) {
      return {
        progress: (localTimeSec - outStart) / tDur,
        type: normalizeTransitionType(clip.transitionOut.type),
        phase: 'out',
        audioCrossfade: clip.transitionOut.audioCrossfade ?? true,
      };
    }
  }

  return null;
}

function crossDissolveDurationFrames(transition: ClipItem['transitionIn'] | null): number {
  if (!transition) return 0;
  if (normalizeTransitionType(transition.type) !== 'cross-dissolve') return 0;
  return Math.max(0, transition.duration.frames);
}

function resolveCenteredDissolvePairs(
  sequence: Sequence,
  playheadTime: TimeValue,
): CenteredDissolvePair[] {
  const playheadFrame = playheadTime.frames;
  const pairs: CenteredDissolvePair[] = [];

  for (const track of sequence.tracks) {
    const clips = [...track.clips]
      .filter((clip) => !clip.disabled)
      .sort((a, b) => a.startTime.frames - b.startTime.frames);

    for (let i = 0; i < clips.length - 1; i++) {
      const outgoing = clips[i];
      const incoming = clips[i + 1];
      const cutFrame = outgoing.startTime.frames + outgoing.duration.frames;
      if (cutFrame !== incoming.startTime.frames) continue;

      const outDur = crossDissolveDurationFrames(outgoing.transitionOut);
      const inDur = crossDissolveDurationFrames(incoming.transitionIn);
      if (outDur <= 0 && inDur <= 0) continue;

      const durationFrames = outDur > 0 && inDur > 0 ? Math.min(outDur, inDur) : Math.max(outDur, inDur);
      if (durationFrames <= 0) continue;

      const half = durationFrames / 2;
      const windowStart = cutFrame - half;
      const windowEnd = cutFrame + half;
      if (playheadFrame < windowStart || playheadFrame >= windowEnd) continue;

      const progress = (playheadFrame - windowStart) / durationFrames;
      pairs.push({
        track,
        outgoing,
        incoming,
        cutFrame,
        progress: Math.max(0, Math.min(1, progress)),
        audioCrossfade:
          outgoing.transitionOut?.audioCrossfade ??
          incoming.transitionIn?.audioCrossfade ??
          true,
      });
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export function buildCompositionPlan(
  sequence: Sequence,
  playheadTime: TimeValue,
): CompositionPlan {
  const activeClips = resolveActiveClips(sequence, playheadTime);
  const audibleIds = resolveAudibleTrackIds(sequence.tracks);
  const centeredPairs = resolveCenteredDissolvePairs(sequence, playheadTime);

  const videoLayers: VideoLayer[] = [];
  const audioSources: AudioSource[] = [];
  const centeredClipIds = new Set<string>();
  const centeredByTrack = new Map<string, CenteredDissolvePair[]>();

  for (const pair of centeredPairs) {
    centeredClipIds.add(pair.outgoing.id);
    centeredClipIds.add(pair.incoming.id);
    const list = centeredByTrack.get(pair.track.id) ?? [];
    list.push(pair);
    centeredByTrack.set(pair.track.id, list);
  }

  const activeByTrack = new Map<string, typeof activeClips>();
  for (const active of activeClips) {
    const list = activeByTrack.get(active.track.id) ?? [];
    list.push(active);
    activeByTrack.set(active.track.id, list);
  }

  const appendClipContribution = (
    clip: ClipItem,
    track: Track,
    clipLocalTime: TimeValue,
    sourceTime: TimeValue,
    transitionOverride?: TransitionSpec | null,
  ): void => {
    const localTimeSec = timeValueToSeconds(clipLocalTime);
    const transition = transitionOverride ?? resolveTransition(clip, localTimeSec);

    if ((clip.type === 'video' || clip.type === 'image') && track.visible && !track.muted) {
      const transform: TransformState = {
        positionX: getPropertyValue(clip, 'transform.positionX', clipLocalTime),
        positionY: getPropertyValue(clip, 'transform.positionY', clipLocalTime),
        scaleX: getPropertyValue(clip, 'transform.scaleX', clipLocalTime),
        scaleY: getPropertyValue(clip, 'transform.scaleY', clipLocalTime),
        rotation: getPropertyValue(clip, 'transform.rotation', clipLocalTime),
        anchorX: getPropertyValue(clip, 'transform.anchorX', clipLocalTime),
        anchorY: getPropertyValue(clip, 'transform.anchorY', clipLocalTime),
      };

      const opacity = Math.max(0, Math.min(1, getPropertyValue(clip, 'opacity', clipLocalTime)));

      videoLayers.push({
        clipId: clip.id,
        trackId: track.id,
        mediaAssetId: clip.mediaAssetId,
        sourceTime,
        transform,
        opacity,
        blendMode: clip.blendMode,
        generator: clip.generator,
        transitionProgress: transition?.progress ?? null,
        transitionType: transition?.type ?? null,
        transitionPhase: transition?.phase ?? null,
        transitionAudioCrossfade: transition?.audioCrossfade ?? false,
      });
    }

    if ((clip.type === 'video' || clip.type === 'audio') && audibleIds.has(track.id)) {
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
        transitionProgress: transition?.progress ?? null,
        transitionType: transition?.type ?? null,
        transitionPhase: transition?.phase ?? null,
        transitionAudioCrossfade: transition?.audioCrossfade ?? false,
      });
    }
  };

  for (const track of sequence.tracks) {
    const actives = activeByTrack.get(track.id) ?? [];
    for (const active of actives) {
      if (centeredClipIds.has(active.clip.id)) continue;
      appendClipContribution(active.clip, active.track, active.clipLocalTime, active.sourceTime);
    }

    // We append incoming first so that after the final reverse(), outgoing
    // is drawn first and incoming appears on top for source-over compositing.
    for (const pair of centeredByTrack.get(track.id) ?? []) {
      const incomingLocalFrames = playheadTime.frames - pair.cutFrame;
      const outgoingLocalFrames = pair.outgoing.duration.frames + (playheadTime.frames - pair.cutFrame);

      const incomingLocal: TimeValue = { frames: incomingLocalFrames, rate: playheadTime.rate };
      const incomingSource: TimeValue = {
        frames: Math.max(0, pair.incoming.sourceInPoint.frames + incomingLocalFrames),
        rate: playheadTime.rate,
      };
      appendClipContribution(pair.incoming, pair.track, incomingLocal, incomingSource, {
        progress: pair.progress,
        type: 'cross-dissolve',
        phase: 'in',
        audioCrossfade: pair.audioCrossfade,
      });

      const outgoingLocal: TimeValue = { frames: outgoingLocalFrames, rate: playheadTime.rate };
      const outgoingSource: TimeValue = {
        frames: Math.max(0, pair.outgoing.sourceInPoint.frames + outgoingLocalFrames),
        rate: playheadTime.rate,
      };
      appendClipContribution(pair.outgoing, pair.track, outgoingLocal, outgoingSource, {
        progress: pair.progress,
        type: 'cross-dissolve',
        phase: 'out',
        audioCrossfade: pair.audioCrossfade,
      });
    }
  }

  // Sequence tracks are top-to-bottom in the array, so reverse to get
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
