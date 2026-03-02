import type { FrameRate, TimeValue } from '../types/project.js';

/**
 * Convert a TimeValue to seconds.
 */
export function timeValueToSeconds(tv: TimeValue): number {
  return (tv.frames * tv.rate.den) / tv.rate.num;
}

/**
 * Convert seconds to a TimeValue at the given frame rate.
 */
export function secondsToTimeValue(seconds: number, rate: FrameRate): TimeValue {
  const frames = Math.round((seconds * rate.num) / rate.den);
  return { frames, rate };
}

/**
 * Convert a TimeValue to frames at a different frame rate.
 */
export function convertTimeValue(tv: TimeValue, targetRate: FrameRate): TimeValue {
  const seconds = timeValueToSeconds(tv);
  return secondsToTimeValue(seconds, targetRate);
}

/**
 * Get the floating-point FPS value from a FrameRate.
 */
export function frameRateToFps(rate: FrameRate): number {
  return rate.num / rate.den;
}

/**
 * Create a TimeValue from a frame number and rate.
 */
export function createTimeValue(frames: number, rate: FrameRate): TimeValue {
  return { frames, rate };
}

/**
 * Add two TimeValues (must be at the same rate).
 * If rates differ, converts the second to match the first.
 */
export function addTimeValues(a: TimeValue, b: TimeValue): TimeValue {
  if (a.rate.num === b.rate.num && a.rate.den === b.rate.den) {
    return { frames: a.frames + b.frames, rate: a.rate };
  }
  const bConverted = convertTimeValue(b, a.rate);
  return { frames: a.frames + bConverted.frames, rate: a.rate };
}

/**
 * Subtract b from a (must be at the same rate).
 */
export function subtractTimeValues(a: TimeValue, b: TimeValue): TimeValue {
  if (a.rate.num === b.rate.num && a.rate.den === b.rate.den) {
    return { frames: a.frames - b.frames, rate: a.rate };
  }
  const bConverted = convertTimeValue(b, a.rate);
  return { frames: a.frames - bConverted.frames, rate: a.rate };
}

/**
 * Compare two TimeValues. Returns <0, 0, or >0.
 */
export function compareTimeValues(a: TimeValue, b: TimeValue): number {
  const aSeconds = timeValueToSeconds(a);
  const bSeconds = timeValueToSeconds(b);
  return aSeconds - bSeconds;
}

/**
 * Format a TimeValue as timecode string (HH:MM:SS:FF).
 */
export function formatTimecode(tv: TimeValue): string {
  const fps = frameRateToFps(tv.rate);
  const totalFrames = tv.frames;
  const framesPerSec = Math.round(fps);

  const ff = totalFrames % framesPerSec;
  const totalSeconds = Math.floor(totalFrames / framesPerSec);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);

  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/**
 * Format a TimeValue as a simple time string (HH:MM:SS.ms).
 */
export function formatTime(tv: TimeValue): string {
  const totalSeconds = timeValueToSeconds(tv);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = Math.floor(totalSeconds % 60);
  const ms = Math.round((totalSeconds % 1) * 100);

  if (hh > 0) {
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(ms)}`;
  }
  return `${pad(mm)}:${pad(ss)}.${pad(ms)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Common frame rates.
 */
export const FRAME_RATES = {
  FPS_23_976: { num: 24000, den: 1001 } as FrameRate,
  FPS_24: { num: 24, den: 1 } as FrameRate,
  FPS_25: { num: 25, den: 1 } as FrameRate,
  FPS_29_97: { num: 30000, den: 1001 } as FrameRate,
  FPS_30: { num: 30, den: 1 } as FrameRate,
  FPS_50: { num: 50, den: 1 } as FrameRate,
  FPS_59_94: { num: 60000, den: 1001 } as FrameRate,
  FPS_60: { num: 60, den: 1 } as FrameRate,
} as const;
