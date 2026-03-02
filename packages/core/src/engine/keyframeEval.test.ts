import { describe, it, expect } from 'vitest';
import type { FrameRate, TimeValue } from '../types/project.js';
import type { Keyframe } from '../types/keyframe.js';
import type { ClipItem } from '../types/timeline.js';
import {
  applyEasing,
  interpolate,
  evaluateKeyframes,
  getPropertyValue,
} from './keyframeEval.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FPS24: FrameRate = { num: 24, den: 1 };

function tv(frames: number): TimeValue {
  return { frames, rate: FPS24 };
}

function makeKf(
  id: string,
  frames: number,
  value: number,
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'bezier' = 'linear',
): Keyframe {
  return {
    id,
    clipId: 'C1',
    property: 'opacity',
    time: tv(frames),
    value,
    easing,
  };
}

function makeClip(keyframes: Keyframe[]): ClipItem {
  return {
    id: 'C1',
    trackId: 'T1',
    mediaAssetId: 'M1',
    type: 'video',
    name: 'Clip',
    startTime: tv(0),
    duration: tv(96),
    sourceInPoint: tv(0),
    sourceOutPoint: tv(96),
    volume: 0.8,
    pan: 0,
    audioEnvelope: [],
    transform: {
      positionX: 100, positionY: 50, scaleX: 1, scaleY: 1,
      rotation: 0, anchorX: 0, anchorY: 0,
    },
    opacity: 0.5,
    blendMode: 'normal',
    keyframes,
    transitionIn: null,
    transitionOut: null,
    masks: [],
    disabled: false,
  };
}

// ---------------------------------------------------------------------------
// applyEasing
// ---------------------------------------------------------------------------

describe('applyEasing', () => {
  it('linear returns t unchanged', () => {
    expect(applyEasing(0, 'linear')).toBe(0);
    expect(applyEasing(0.5, 'linear')).toBe(0.5);
    expect(applyEasing(1, 'linear')).toBe(1);
  });

  it('ease-in starts slow', () => {
    const v = applyEasing(0.5, 'ease-in');
    expect(v).toBeLessThan(0.5);
    expect(v).toBeCloseTo(0.25); // t^2
  });

  it('ease-out ends slow', () => {
    const v = applyEasing(0.5, 'ease-out');
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeCloseTo(0.75); // 1 - (1-t)^2
  });

  it('ease-in-out is symmetric', () => {
    expect(applyEasing(0, 'ease-in-out')).toBeCloseTo(0);
    expect(applyEasing(0.5, 'ease-in-out')).toBeCloseTo(0.5);
    expect(applyEasing(1, 'ease-in-out')).toBeCloseTo(1);
  });

  it('bezier with linear handles ≈ linear', () => {
    // handles that approximate a straight line
    const handles = { inX: 0.75, inY: 0.75, outX: 0.25, outY: 0.25 };
    const v = applyEasing(0.5, 'bezier', handles);
    expect(v).toBeCloseTo(0.5, 1);
  });

  it('clamps t < 0 to 0', () => {
    expect(applyEasing(-0.1, 'linear')).toBe(0);
  });

  it('clamps t > 1 to 1', () => {
    expect(applyEasing(1.5, 'linear')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// interpolate
// ---------------------------------------------------------------------------

describe('interpolate', () => {
  it('interpolates linearly between two keyframes', () => {
    const from = makeKf('K1', 0, 0, 'linear');
    const to = makeKf('K2', 24, 1, 'linear');
    expect(interpolate(from, to, 0)).toBeCloseTo(0);
    expect(interpolate(from, to, 0.5)).toBeCloseTo(0.5);
    expect(interpolate(from, to, 1)).toBeCloseTo(1);
  });

  it('applies ease-in easing from the source keyframe', () => {
    const from = makeKf('K1', 0, 0, 'ease-in');
    const to = makeKf('K2', 24, 100, 'linear');
    // At t=0.5, ease-in gives 0.25, so value = 0 + 100*0.25 = 25
    expect(interpolate(from, to, 0.5)).toBeCloseTo(25);
  });
});

// ---------------------------------------------------------------------------
// evaluateKeyframes
// ---------------------------------------------------------------------------

describe('evaluateKeyframes', () => {
  it('returns defaultValue when no keyframes exist', () => {
    expect(evaluateKeyframes([], 'opacity', tv(10), 0.75)).toBe(0.75);
  });

  it('returns the single keyframe value regardless of time', () => {
    const kf = makeKf('K1', 12, 0.3);
    expect(evaluateKeyframes([kf], 'opacity', tv(0), 1)).toBe(0.3);
    expect(evaluateKeyframes([kf], 'opacity', tv(50), 1)).toBe(0.3);
  });

  it('holds first value before first keyframe', () => {
    const kfs = [makeKf('K1', 10, 0.2), makeKf('K2', 20, 0.8)];
    expect(evaluateKeyframes(kfs, 'opacity', tv(0), 1)).toBe(0.2);
  });

  it('holds last value after last keyframe', () => {
    const kfs = [makeKf('K1', 10, 0.2), makeKf('K2', 20, 0.8)];
    expect(evaluateKeyframes(kfs, 'opacity', tv(50), 1)).toBe(0.8);
  });

  it('interpolates between keyframes', () => {
    const kfs = [makeKf('K1', 0, 0, 'linear'), makeKf('K2', 24, 1, 'linear')];
    const val = evaluateKeyframes(kfs, 'opacity', tv(12), 0);
    expect(val).toBeCloseTo(0.5);
  });

  it('filters by property name', () => {
    const opacityKf: Keyframe = {
      ...makeKf('K1', 0, 0.5),
      property: 'opacity',
    };
    const volumeKf: Keyframe = {
      ...makeKf('K2', 0, 0.9),
      property: 'volume',
    };
    // Asking for volume should only see volumeKf
    expect(evaluateKeyframes([opacityKf, volumeKf], 'volume', tv(0), 1)).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// getPropertyValue
// ---------------------------------------------------------------------------

describe('getPropertyValue', () => {
  it('returns clip default when no keyframes exist', () => {
    const clip = makeClip([]);
    expect(getPropertyValue(clip, 'opacity', tv(10))).toBe(0.5);
    expect(getPropertyValue(clip, 'volume', tv(10))).toBe(0.8);
    expect(getPropertyValue(clip, 'transform.positionX', tv(10))).toBe(100);
  });

  it('returns keyframed value when keyframes exist', () => {
    const kf: Keyframe = {
      id: 'K1',
      clipId: 'C1',
      property: 'opacity',
      time: tv(0),
      value: 0.9,
      easing: 'linear',
    };
    const clip = makeClip([kf]);
    expect(getPropertyValue(clip, 'opacity', tv(10))).toBe(0.9);
  });
});
