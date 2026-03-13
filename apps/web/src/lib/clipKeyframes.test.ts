import { describe, expect, it } from 'vitest';
import type { TimelineClipData } from '../stores/projectStore.js';
import { evaluateClipNumericKeyframe, resolveClipSourceFrameAtLocalFrame } from './clipKeyframes.js';

function makeClip(overrides: Partial<TimelineClipData> = {}): TimelineClipData {
  return {
    id: 'c1',
    name: 'clip',
    type: 'video',
    startFrame: 0,
    durationFrames: 100,
    mediaAssetId: 'm1',
    sourceInFrame: 0,
    sourceOutFrame: 100,
    speed: 1,
    keyframes: [],
    ...overrides,
  };
}

describe('clipKeyframes', () => {
  it('evaluates default when no keyframes exist', () => {
    const clip = makeClip();
    expect(evaluateClipNumericKeyframe(clip, 'brightness', 12, 1)).toBe(1);
  });

  it('interpolates numeric keyframes with easing', () => {
    const clip = makeClip({
      keyframes: [
        { id: 'k1', property: 'hue', frame: 0, value: 0, easing: 'linear' },
        { id: 'k2', property: 'hue', frame: 20, value: 100, easing: 'linear' },
      ],
    });
    expect(evaluateClipNumericKeyframe(clip, 'hue', 10, 0)).toBeCloseTo(50, 6);
  });

  it('applies incoming easing from the destination keyframe', () => {
    const clip = makeClip({
      keyframes: [
        { id: 'k1', property: 'hue', frame: 0, value: 0, easing: 'linear' },
        { id: 'k2', property: 'hue', frame: 20, value: 100, easing: 'ease-in' },
      ],
    });
    expect(evaluateClipNumericKeyframe(clip, 'hue', 16, 0)).toBeGreaterThan(80);
  });

  it('resolves source frame for forward speed', () => {
    const clip = makeClip({ speed: 2 });
    expect(resolveClipSourceFrameAtLocalFrame(clip, 10)).toBeCloseTo(20, 2);
  });

  it('resolves source frame for reverse speed', () => {
    const clip = makeClip({ speed: -1, sourceInFrame: 0, sourceOutFrame: 100 });
    expect(resolveClipSourceFrameAtLocalFrame(clip, 5)).toBeCloseTo(94, 2);
  });

  it('integrates animated speed over time', () => {
    const clip = makeClip({
      speed: 1,
      keyframes: [
        { id: 'k1', property: 'speed', frame: 0, value: 1, easing: 'linear' },
        { id: 'k2', property: 'speed', frame: 10, value: 2, easing: 'linear' },
      ],
    });
    const frame = resolveClipSourceFrameAtLocalFrame(clip, 10);
    expect(frame).toBeGreaterThan(14);
    expect(frame).toBeLessThan(16);
  });
});
