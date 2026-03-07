import { describe, it, expect } from 'vitest';
import { applyKeyframeEasing } from './keyframeEasing.js';

describe('applyKeyframeEasing', () => {
  it('applies classic easing curves', () => {
    expect(applyKeyframeEasing(0.5, 'linear')).toBeCloseTo(0.5, 6);
    expect(applyKeyframeEasing(0.5, 'ease-in')).toBeCloseTo(0.25, 6);
    expect(applyKeyframeEasing(0.5, 'ease-out')).toBeCloseTo(0.75, 6);
    expect(applyKeyframeEasing(0.5, 'ease-in-out')).toBeCloseTo(0.5, 6);
  });

  it('falls back to linear when bezier handles are missing', () => {
    expect(applyKeyframeEasing(0.37, 'bezier')).toBeCloseTo(0.37, 6);
  });

  it('supports custom bezier curves', () => {
    const t = 0.25;
    const eased = applyKeyframeEasing(t, 'bezier', {
      outX: 0.15,
      outY: 0.9,
      inX: 0.55,
      inY: 0.9,
    });
    expect(eased).toBeGreaterThan(0);
    expect(eased).toBeLessThan(1);
    expect(Math.abs(eased - t)).toBeGreaterThan(0.01);
  });
});
