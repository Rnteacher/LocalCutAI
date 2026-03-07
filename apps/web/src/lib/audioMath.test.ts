import { describe, expect, it } from 'vitest';
import {
  applyGain,
  applyStereoBalance,
  buildRoutingMatrix,
  computePeakDbfs,
  dbToGain,
  gainToDb,
  mixBuffers,
  resolveChannelMode,
} from './audioMath.js';

describe('audioMath', () => {
  it('converts dB to gain including -inf behavior', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
    expect(dbToGain(-6)).toBeCloseTo(0.501187, 5);
    expect(dbToGain(-12)).toBeCloseTo(0.251189, 5);
    expect(dbToGain(-60)).toBe(0);
  });

  it('converts gain to dB', () => {
    expect(gainToDb(1)).toBeCloseTo(0, 6);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
  });

  it('applies hard edge stereo balance', () => {
    expect(applyStereoBalance(-1)).toEqual({ left: 1, right: 0 });
    expect(applyStereoBalance(1)).toEqual({ left: 0, right: 1 });
    const center = applyStereoBalance(0);
    expect(center.left).toBeCloseTo(1, 6);
    expect(center.right).toBeCloseTo(1, 6);
  });

  it('resolves channel modes from track settings', () => {
    expect(resolveChannelMode('stereo', 'L+R')).toBe('stereo');
    expect(resolveChannelMode('mono', 'L')).toBe('mono-left');
    expect(resolveChannelMode('mono', 'R')).toBe('mono-right');
    expect(resolveChannelMode('mono', 'L+R')).toBe('mono-sum');
  });

  it('builds routing matrix with hard pan edges', () => {
    const leftOnly = buildRoutingMatrix('stereo', -1);
    expect(leftOnly.ll).toBe(1);
    expect(leftOnly.rr).toBe(0);

    const rightOnly = buildRoutingMatrix('stereo', 1);
    expect(rightOnly.ll).toBe(0);
    expect(rightOnly.rr).toBe(1);
  });

  it('applies gain linearly', () => {
    const inBuf = new Float32Array([1, -1, 0.5]);
    const out = applyGain(inBuf, 0.5);
    expect(Array.from(out)).toEqual([0.5, -0.5, 0.25]);
  });

  it('mixes buffers by summing samples', () => {
    const a = new Float32Array([0.1, 0.2, 0.3]);
    const b = new Float32Array([0.2, 0.2, 0.2]);
    const out = mixBuffers([a, b]);
    expect(out[0]).toBeCloseTo(0.3, 5);
    expect(out[1]).toBeCloseTo(0.4, 5);
    expect(out[2]).toBeCloseTo(0.5, 5);
  });

  it('computes peak dBFS per channel', () => {
    const [lDb, rDb] = computePeakDbfs([
      new Float32Array([0.5, -0.2, 0.1]),
      new Float32Array([0, 0, 0]),
    ]);
    expect(lDb).toBeCloseTo(-6.02, 1);
    expect(rDb).toBe(Number.NEGATIVE_INFINITY);
  });
});
