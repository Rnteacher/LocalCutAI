/**
 * @module audioMix
 *
 * Evaluates the audio mixing pipeline at a given playhead time.
 *
 * The audio gain chain for a single clip is:
 *
 *     finalGain = clipVolume × envelopeGain × keyframedVolume × trackGain
 *
 * Stereo panning uses constant-power (equal-power) panning to maintain
 * perceived loudness when the pan knob is moved from centre.
 */

import type { FrameRate, TimeValue } from '../types/project.js';
import type {
  ClipItem,
  AudioEnvelopePoint,
  Sequence,
  Track,
} from '../types/timeline.js';
import type { MixerChannelState, MasterMixerState } from '../types/audio.js';
import { timeValueToSeconds, secondsToTimeValue } from '../utils/timecode.js';
import { evaluateKeyframes } from './keyframeEval.js';
import { resolveActiveClips } from './timeResolver.js';

// ---------------------------------------------------------------------------
// Audio envelope
// ---------------------------------------------------------------------------

/**
 * Evaluate the gain at a given clip-local time by linearly interpolating
 * across the clip's audio envelope points.
 *
 * - If the envelope is empty, returns 1.0 (unity gain).
 * - If the time is before the first point, holds the first point's gain.
 * - If the time is after the last point, holds the last point's gain.
 *
 * @param envelope  - The clip's audio envelope points, sorted by time.
 * @param localTime - Time relative to the clip start.
 * @returns The interpolated gain value.
 */
export function evaluateAudioEnvelope(
  envelope: AudioEnvelopePoint[],
  localTime: TimeValue,
): number {
  if (envelope.length === 0) return 1.0;

  const tSec = timeValueToSeconds(localTime);

  // Before first point — hold.
  const firstSec = timeValueToSeconds(envelope[0].time);
  if (tSec <= firstSec) return envelope[0].gain;

  // After last point — hold.
  const last = envelope[envelope.length - 1];
  const lastSec = timeValueToSeconds(last.time);
  if (tSec >= lastSec) return last.gain;

  // Find surrounding pair and linearly interpolate.
  for (let i = 0; i < envelope.length - 1; i++) {
    const a = envelope[i];
    const b = envelope[i + 1];
    const aSec = timeValueToSeconds(a.time);
    const bSec = timeValueToSeconds(b.time);

    if (tSec >= aSec && tSec <= bSec) {
      const span = bSec - aSec;
      if (span === 0) return a.gain;
      const t = (tSec - aSec) / span;
      return a.gain + (b.gain - a.gain) * t;
    }
  }

  // Should be unreachable.
  return 1.0;
}

// ---------------------------------------------------------------------------
// Clip-level gain
// ---------------------------------------------------------------------------

/**
 * Compute the final gain for a clip at a given local time.
 *
 * The gain chain is:
 * `clip.volume × envelopeGain × keyframedVolume`
 *
 * Note: track-level gain is applied separately so callers can access the
 * clip-only gain independently.
 *
 * @param clip      - The clip to evaluate.
 * @param localTime - Time relative to the clip start.
 * @returns The combined clip-level gain (0 = silence).
 */
export function computeClipGain(clip: ClipItem, localTime: TimeValue): number {
  const envelopeGain = evaluateAudioEnvelope(clip.audioEnvelope, localTime);

  // Keyframed volume override (1.0 is the clip's base volume).
  const kfVolume = evaluateKeyframes(clip.keyframes, 'volume', localTime, clip.volume);

  return kfVolume * envelopeGain;
}

// ---------------------------------------------------------------------------
// Track-level gain
// ---------------------------------------------------------------------------

/**
 * Compute the effective gain for a track taking the muted flag into account.
 *
 * @param track - The track to evaluate.
 * @returns 0 if the track is muted, otherwise `track.volume`.
 */
export function computeTrackGain(track: Track): number {
  if (track.muted) return 0;
  return track.volume;
}

/**
 * Resolve solo state across all tracks in a sequence.
 *
 * If *any* audio track has `solo = true`, all non-soloed audio tracks are
 * treated as muted regardless of their individual `muted` flag.
 *
 * @param tracks - All tracks in the sequence.
 * @returns A set of track IDs that should be audible.
 */
export function resolveAudibleTrackIds(tracks: Track[]): Set<string> {
  const audioTracks = tracks.filter((t) => t.type === 'audio');
  const anySolo = audioTracks.some((t) => t.solo);

  const audible = new Set<string>();

  for (const t of audioTracks) {
    if (anySolo) {
      if (t.solo && !t.muted) audible.add(t.id);
    } else {
      if (!t.muted) audible.add(t.id);
    }
  }

  // Video tracks with audio are always included unless muted.
  for (const t of tracks.filter((t) => t.type === 'video')) {
    if (!t.muted) audible.add(t.id);
  }

  return audible;
}

// ---------------------------------------------------------------------------
// Stereo panning (constant-power)
// ---------------------------------------------------------------------------

/**
 * Compute left/right gain coefficients from clip and track pan values using
 * constant-power panning.
 *
 * Both `clipPan` and `trackPan` are in the range [-1, 1].  They are combined
 * additively and clamped before computing the coefficients.
 *
 * Constant-power panning uses sine/cosine so that the perceived loudness
 * remains constant as the signal is panned across the stereo field.
 *
 * @param clipPan  - Clip-level pan (-1 = full left, 0 = centre, 1 = full right).
 * @param trackPan - Track-level pan.
 * @returns An object with `left` and `right` gain multipliers in [0, 1].
 */
export function computeStereoPan(
  clipPan: number,
  trackPan: number,
): { left: number; right: number } {
  const combined = Math.max(-1, Math.min(1, clipPan + trackPan));

  // Map combined pan from [-1, 1] to [0, π/2].
  const angle = ((combined + 1) / 2) * (Math.PI / 2);

  return {
    left: Math.cos(angle),
    right: Math.sin(angle),
  };
}

// ---------------------------------------------------------------------------
// Full mixer state builder
// ---------------------------------------------------------------------------

/**
 * Build the mixer channel state for all audio-bearing tracks at the given
 * playhead time.
 *
 * This is used by the mixer UI panel to display fader positions, peak meters,
 * and mute/solo states.
 *
 * @param sequence     - The sequence to evaluate.
 * @param playheadTime - Current playhead position.
 * @returns An array of {@link MixerChannelState} for each track.
 */
export function buildMixerChannelStates(
  sequence: Sequence,
  playheadTime: TimeValue,
): MixerChannelState[] {
  const activeClips = resolveActiveClips(sequence, playheadTime);
  const audible = resolveAudibleTrackIds(sequence.tracks);

  return sequence.tracks.map((track): MixerChannelState => {
    const isAudible = audible.has(track.id);

    // Find the active clip for this track (if any).
    const active = activeClips.find((ac) => ac.track.id === track.id);

    let peakL = 0;
    let peakR = 0;

    if (active && isAudible) {
      const clipGain = computeClipGain(active.clip, active.clipLocalTime);
      const trackGain = computeTrackGain(track);
      const totalGain = clipGain * trackGain;
      const pan = computeStereoPan(active.clip.pan, track.pan);
      peakL = totalGain * pan.left;
      peakR = totalGain * pan.right;
    }

    return {
      trackId: track.id,
      volume: track.volume,
      pan: track.pan,
      peakL,
      peakR,
      muted: track.muted,
      solo: track.solo,
    };
  });
}
