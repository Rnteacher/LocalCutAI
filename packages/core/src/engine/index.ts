/**
 * @module engine
 *
 * Timeline engine barrel exports.
 *
 * The engine provides the per-frame evaluation pipeline:
 *
 * 1. **timeResolver** – determine which clips overlap the playhead.
 * 2. **keyframeEval** – evaluate animated properties at the current time.
 * 3. **audioMix**     – compute gain, envelope, and panning for audio.
 * 4. **compositionPlan** – assemble the full rendering instructions.
 */

export {
  type ActiveClip,
  getClipEndTime,
  isTimeInClip,
  getClipAtTime,
  resolveActiveClips,
} from './timeResolver.js';

export {
  applyEasing,
  interpolate,
  evaluateKeyframes,
  getPropertyValue,
} from './keyframeEval.js';

export {
  evaluateAudioEnvelope,
  computeClipGain,
  computeTrackGain,
  resolveAudibleTrackIds,
  computeStereoPan,
  buildMixerChannelStates,
} from './audioMix.js';

export {
  type VideoLayer,
  type AudioSource,
  type CompositionPlan,
  buildCompositionPlan,
} from './compositionPlan.js';
