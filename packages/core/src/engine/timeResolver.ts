/**
 * @module timeResolver
 *
 * Resolves which clips are active at a given playhead position within a
 * sequence. This is the first step of the per-frame pipeline: before we can
 * evaluate keyframes, mix audio, or build a composition plan we need to know
 * which clips overlap the current time and what their local / source times are.
 */

import type { TimeValue } from '../types/project.js';
import type { Sequence, Track, ClipItem } from '../types/timeline.js';
import {
  addTimeValues,
  subtractTimeValues,
  compareTimeValues,
} from '../utils/timecode.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Represents a clip that is active (overlapping) at a particular playhead
 * position, together with the derived timing information the downstream
 * pipeline needs.
 */
export interface ActiveClip {
  /** Reference to the clip instance on the timeline. */
  clip: ClipItem;
  /** Reference to the track that owns the clip. */
  track: Track;
  /**
   * The playhead time expressed relative to the clip's start on the timeline.
   * Always >= 0 and < clip.duration.
   */
  clipLocalTime: TimeValue;
  /**
   * The corresponding time in the source media file.
   * Computed as `clip.sourceInPoint + clipLocalTime`.
   */
  sourceTime: TimeValue;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Compute the end time of a clip on the timeline.
 *
 * @param clip - The clip whose end time to compute.
 * @returns `clip.startTime + clip.duration` as a {@link TimeValue}.
 */
export function getClipEndTime(clip: ClipItem): TimeValue {
  return addTimeValues(clip.startTime, clip.duration);
}

/**
 * Determine whether a given timeline time falls within a clip's range.
 *
 * The range is inclusive at the start and exclusive at the end:
 * `clip.startTime <= time < clip.startTime + clip.duration`.
 *
 * @param clip - The clip to test against.
 * @param time - The timeline time to test.
 * @returns `true` if `time` is inside the clip's timeline range.
 */
export function isTimeInClip(clip: ClipItem, time: TimeValue): boolean {
  const startCmp = compareTimeValues(time, clip.startTime);
  if (startCmp < 0) return false;

  const endTime = getClipEndTime(clip);
  const endCmp = compareTimeValues(time, endTime);
  return endCmp < 0;
}

// ---------------------------------------------------------------------------
// Single-track lookup
// ---------------------------------------------------------------------------

/**
 * Find the clip on a specific track at the given timeline time.
 *
 * Only non-disabled clips are considered.  If no clip overlaps the time,
 * `null` is returned.
 *
 * @param track - The track to search.
 * @param time  - The timeline time to query.
 * @returns The first matching {@link ClipItem}, or `null`.
 */
export function getClipAtTime(track: Track, time: TimeValue): ClipItem | null {
  for (const clip of track.clips) {
    if (clip.disabled) continue;
    if (isTimeInClip(clip, time)) return clip;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sequence-wide resolution
// ---------------------------------------------------------------------------

/**
 * Resolve every active (non-disabled) clip at the given playhead time across
 * all tracks in the sequence.
 *
 * The returned array preserves the track ordering of the sequence (which is
 * top-to-bottom in the UI: V3, V2, V1, A1, A2, A3).  Downstream consumers
 * that need bottom-to-top rendering order should reverse the video portion.
 *
 * @param sequence     - The sequence to query.
 * @param playheadTime - The current playhead position on the timeline.
 * @returns An array of {@link ActiveClip} entries for every clip that overlaps
 *          the playhead.
 */
export function resolveActiveClips(
  sequence: Sequence,
  playheadTime: TimeValue,
): ActiveClip[] {
  const result: ActiveClip[] = [];

  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.disabled) continue;
      if (!isTimeInClip(clip, playheadTime)) continue;

      const clipLocalTime = subtractTimeValues(playheadTime, clip.startTime);
      const sourceTime = addTimeValues(clip.sourceInPoint, clipLocalTime);

      result.push({
        clip,
        track,
        clipLocalTime,
        sourceTime,
      });
    }
  }

  return result;
}
