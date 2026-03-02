import { describe, it, expect } from 'vitest';
import type { FrameRate, TimeValue } from '../types/project.js';
import type { Track, ClipItem, AudioEnvelopePoint, Sequence } from '../types/timeline.js';
import {
  evaluateAudioEnvelope,
  computeClipGain,
  computeTrackGain,
  resolveAudibleTrackIds,
  computeStereoPan,
  buildMixerChannelStates,
} from './audioMix.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FPS24: FrameRate = { num: 24, den: 1 };

function tv(frames: number): TimeValue {
  return { frames, rate: FPS24 };
}

function makeClip(overrides: Partial<ClipItem> = {}): ClipItem {
  return {
    id: 'C1',
    trackId: 'T1',
    mediaAssetId: 'M1',
    type: 'audio',
    name: 'Clip',
    startTime: tv(0),
    duration: tv(96),
    sourceInPoint: tv(0),
    sourceOutPoint: tv(96),
    volume: 1,
    pan: 0,
    audioEnvelope: [],
    transform: {
      positionX: 0, positionY: 0, scaleX: 1, scaleY: 1,
      rotation: 0, anchorX: 0, anchorY: 0,
    },
    opacity: 1,
    blendMode: 'normal',
    keyframes: [],
    transitionIn: null,
    transitionOut: null,
    masks: [],
    disabled: false,
    ...overrides,
  };
}

function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    sequenceId: 'SEQ1',
    name: id,
    type: 'audio',
    index: 0,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluateAudioEnvelope
// ---------------------------------------------------------------------------

describe('evaluateAudioEnvelope', () => {
  it('returns 1.0 for empty envelope', () => {
    expect(evaluateAudioEnvelope([], tv(10))).toBe(1.0);
  });

  it('holds first value before first point', () => {
    const env: AudioEnvelopePoint[] = [
      { time: tv(10), gain: 0.5 },
      { time: tv(20), gain: 1.0 },
    ];
    expect(evaluateAudioEnvelope(env, tv(0))).toBe(0.5);
  });

  it('holds last value after last point', () => {
    const env: AudioEnvelopePoint[] = [
      { time: tv(10), gain: 0.5 },
      { time: tv(20), gain: 0.8 },
    ];
    expect(evaluateAudioEnvelope(env, tv(50))).toBe(0.8);
  });

  it('interpolates linearly between points', () => {
    const env: AudioEnvelopePoint[] = [
      { time: tv(0), gain: 0.0 },
      { time: tv(24), gain: 1.0 },
    ];
    const val = evaluateAudioEnvelope(env, tv(12));
    expect(val).toBeCloseTo(0.5);
  });

  it('returns exact value at envelope point', () => {
    const env: AudioEnvelopePoint[] = [
      { time: tv(0), gain: 0.3 },
      { time: tv(24), gain: 0.7 },
    ];
    expect(evaluateAudioEnvelope(env, tv(0))).toBeCloseTo(0.3);
    expect(evaluateAudioEnvelope(env, tv(24))).toBeCloseTo(0.7);
  });
});

// ---------------------------------------------------------------------------
// computeClipGain
// ---------------------------------------------------------------------------

describe('computeClipGain', () => {
  it('returns clip volume when no envelope or keyframes', () => {
    const clip = makeClip({ volume: 0.75 });
    // With no keyframes, keyframed volume = clip.volume = 0.75
    // envelope = 1.0 (empty)
    // result = 0.75 * 1.0 = 0.75
    expect(computeClipGain(clip, tv(10))).toBeCloseTo(0.75);
  });

  it('multiplies by envelope gain', () => {
    const clip = makeClip({
      volume: 1.0,
      audioEnvelope: [
        { time: tv(0), gain: 0.5 },
        { time: tv(48), gain: 0.5 },
      ],
    });
    // clip gain = keyframed(1.0) * envelope(0.5) = 0.5
    expect(computeClipGain(clip, tv(12))).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeTrackGain
// ---------------------------------------------------------------------------

describe('computeTrackGain', () => {
  it('returns volume when not muted', () => {
    const track = makeTrack('A1', { volume: 0.8 });
    expect(computeTrackGain(track)).toBe(0.8);
  });

  it('returns 0 when muted', () => {
    const track = makeTrack('A1', { volume: 0.8, muted: true });
    expect(computeTrackGain(track)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveAudibleTrackIds
// ---------------------------------------------------------------------------

describe('resolveAudibleTrackIds', () => {
  it('includes all non-muted audio tracks when no solo', () => {
    const tracks = [
      makeTrack('A1'),
      makeTrack('A2', { muted: true }),
      makeTrack('A3'),
    ];
    const ids = resolveAudibleTrackIds(tracks);
    expect(ids.has('A1')).toBe(true);
    expect(ids.has('A2')).toBe(false);
    expect(ids.has('A3')).toBe(true);
  });

  it('only includes soloed tracks when solo is active', () => {
    const tracks = [
      makeTrack('A1', { solo: true }),
      makeTrack('A2'),
      makeTrack('A3'),
    ];
    const ids = resolveAudibleTrackIds(tracks);
    expect(ids.has('A1')).toBe(true);
    expect(ids.has('A2')).toBe(false);
    expect(ids.has('A3')).toBe(false);
  });

  it('solo + muted = silent', () => {
    const tracks = [
      makeTrack('A1', { solo: true, muted: true }),
      makeTrack('A2'),
    ];
    const ids = resolveAudibleTrackIds(tracks);
    expect(ids.has('A1')).toBe(false);
    expect(ids.has('A2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeStereoPan
// ---------------------------------------------------------------------------

describe('computeStereoPan', () => {
  it('centre pan gives equal L/R', () => {
    const { left, right } = computeStereoPan(0, 0);
    expect(left).toBeCloseTo(right, 5);
    // cos(π/4) = sin(π/4) ≈ 0.707
    expect(left).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('full left pan gives L=1, R=0', () => {
    const { left, right } = computeStereoPan(-1, 0);
    expect(left).toBeCloseTo(1, 5);
    expect(right).toBeCloseTo(0, 5);
  });

  it('full right pan gives L=0, R=1', () => {
    const { left, right } = computeStereoPan(1, 0);
    expect(left).toBeCloseTo(0, 5);
    expect(right).toBeCloseTo(1, 5);
  });

  it('clip + track pan combine additively', () => {
    // 0.5 + 0.5 = 1.0 → full right
    const { left, right } = computeStereoPan(0.5, 0.5);
    expect(left).toBeCloseTo(0, 5);
    expect(right).toBeCloseTo(1, 5);
  });

  it('clamps combined pan to [-1, 1]', () => {
    // 0.8 + 0.8 = 1.6, clamped to 1.0
    const { left, right } = computeStereoPan(0.8, 0.8);
    expect(left).toBeCloseTo(0, 5);
    expect(right).toBeCloseTo(1, 5);
  });
});
