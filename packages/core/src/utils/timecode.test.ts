import { describe, it, expect } from 'vitest';
import type { FrameRate, TimeValue } from '../types/project.js';
import {
  timeValueToSeconds,
  secondsToTimeValue,
  convertTimeValue,
  frameRateToFps,
  createTimeValue,
  addTimeValues,
  subtractTimeValues,
  compareTimeValues,
  formatTimecode,
  formatTime,
  FRAME_RATES,
} from './timecode.js';

const FPS24: FrameRate = { num: 24, den: 1 };
const FPS_23_976: FrameRate = FRAME_RATES.FPS_23_976;

function tv(frames: number, rate: FrameRate = FPS24): TimeValue {
  return { frames, rate };
}

// ---------------------------------------------------------------------------
// timeValueToSeconds
// ---------------------------------------------------------------------------

describe('timeValueToSeconds', () => {
  it('converts 24 frames at 24fps to 1 second', () => {
    expect(timeValueToSeconds(tv(24))).toBeCloseTo(1.0);
  });

  it('converts 0 frames to 0 seconds', () => {
    expect(timeValueToSeconds(tv(0))).toBe(0);
  });

  it('handles 23.976fps correctly', () => {
    // 24000/1001 fps → 24 frames = 24 * 1001/24000 = 1.001 seconds
    const t = tv(24, FPS_23_976);
    expect(timeValueToSeconds(t)).toBeCloseTo(1.001, 3);
  });

  it('handles large frame counts', () => {
    // 1 hour at 24fps = 86400 frames
    expect(timeValueToSeconds(tv(86400))).toBeCloseTo(3600);
  });
});

// ---------------------------------------------------------------------------
// secondsToTimeValue
// ---------------------------------------------------------------------------

describe('secondsToTimeValue', () => {
  it('converts 1 second at 24fps to 24 frames', () => {
    const result = secondsToTimeValue(1, FPS24);
    expect(result.frames).toBe(24);
    expect(result.rate).toBe(FPS24);
  });

  it('rounds to nearest frame', () => {
    // 0.5 seconds at 24fps = 12 frames
    const result = secondsToTimeValue(0.5, FPS24);
    expect(result.frames).toBe(12);
  });

  it('handles zero', () => {
    expect(secondsToTimeValue(0, FPS24).frames).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// convertTimeValue
// ---------------------------------------------------------------------------

describe('convertTimeValue', () => {
  it('converts between same rate (identity)', () => {
    const result = convertTimeValue(tv(24), FPS24);
    expect(result.frames).toBe(24);
  });

  it('converts 24fps → 30fps', () => {
    // 24 frames at 24fps = 1 second → 30 frames at 30fps
    const FPS30: FrameRate = { num: 30, den: 1 };
    const result = convertTimeValue(tv(24), FPS30);
    expect(result.frames).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// frameRateToFps
// ---------------------------------------------------------------------------

describe('frameRateToFps', () => {
  it('returns 24 for 24/1', () => {
    expect(frameRateToFps(FPS24)).toBe(24);
  });

  it('returns ~23.976 for 24000/1001', () => {
    expect(frameRateToFps(FPS_23_976)).toBeCloseTo(23.976, 2);
  });
});

// ---------------------------------------------------------------------------
// createTimeValue
// ---------------------------------------------------------------------------

describe('createTimeValue', () => {
  it('creates a TimeValue with given frames and rate', () => {
    const t = createTimeValue(48, FPS24);
    expect(t.frames).toBe(48);
    expect(t.rate).toBe(FPS24);
  });
});

// ---------------------------------------------------------------------------
// addTimeValues / subtractTimeValues
// ---------------------------------------------------------------------------

describe('addTimeValues', () => {
  it('adds two values at the same rate', () => {
    const result = addTimeValues(tv(10), tv(14));
    expect(result.frames).toBe(24);
  });

  it('converts rate when different', () => {
    const FPS30: FrameRate = { num: 30, den: 1 };
    const a = tv(24, FPS24); // 1 second
    const b = tv(30, FPS30); // 1 second
    const result = addTimeValues(a, b);
    expect(result.frames).toBe(48); // 2 seconds at 24fps
    expect(result.rate).toBe(FPS24);
  });
});

describe('subtractTimeValues', () => {
  it('subtracts two values at the same rate', () => {
    const result = subtractTimeValues(tv(24), tv(10));
    expect(result.frames).toBe(14);
  });

  it('can produce negative frames', () => {
    const result = subtractTimeValues(tv(5), tv(10));
    expect(result.frames).toBe(-5);
  });
});

// ---------------------------------------------------------------------------
// compareTimeValues
// ---------------------------------------------------------------------------

describe('compareTimeValues', () => {
  it('returns 0 for equal values', () => {
    expect(compareTimeValues(tv(24), tv(24))).toBe(0);
  });

  it('returns negative when a < b', () => {
    expect(compareTimeValues(tv(10), tv(20))).toBeLessThan(0);
  });

  it('returns positive when a > b', () => {
    expect(compareTimeValues(tv(20), tv(10))).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatTimecode
// ---------------------------------------------------------------------------

describe('formatTimecode', () => {
  it('formats 0 frames as 00:00:00:00', () => {
    expect(formatTimecode(tv(0))).toBe('00:00:00:00');
  });

  it('formats 24 frames at 24fps as 00:00:01:00', () => {
    expect(formatTimecode(tv(24))).toBe('00:00:01:00');
  });

  it('formats with frame remainder', () => {
    expect(formatTimecode(tv(30))).toBe('00:00:01:06');
  });

  it('formats minutes and hours', () => {
    // 1 hour + 2 min + 3 sec + 4 frames at 24fps
    const frames = (1 * 3600 + 2 * 60 + 3) * 24 + 4;
    expect(formatTimecode(tv(frames))).toBe('01:02:03:04');
  });
});

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------

describe('formatTime', () => {
  it('formats 0 as 00:00.00', () => {
    expect(formatTime(tv(0))).toBe('00:00.00');
  });

  it('formats seconds with ms', () => {
    // 36 frames at 24fps = 1.5 seconds → 01:50
    expect(formatTime(tv(36))).toBe('00:01.50');
  });
});
