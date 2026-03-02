import type { FrameRate } from '../types/project.js';

/**
 * Compute the greatest common divisor of two integers using
 * the Euclidean algorithm.  Both inputs are coerced to their
 * absolute values so negative numbers are handled correctly.
 *
 * @param a - First integer
 * @param b - Second integer
 * @returns The greatest common divisor of `a` and `b`
 */
export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/**
 * Compute the least common multiple of two integers.
 *
 * Returns 0 when either input is 0.
 *
 * @param a - First integer
 * @param b - Second integer
 * @returns The least common multiple of `a` and `b`
 */
export function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs(a * b) / gcd(a, b);
}

/**
 * Simplify (reduce) a rational number to its lowest terms.
 *
 * The returned denominator is always positive; if the rational
 * value is negative the sign is carried by the numerator.
 *
 * @param num - Numerator
 * @param den - Denominator (must not be 0)
 * @returns The rational number in lowest terms
 * @throws {Error} If `den` is 0
 */
export function simplifyRational(
  num: number,
  den: number,
): { num: number; den: number } {
  if (den === 0) {
    throw new Error('Denominator must not be zero');
  }

  const d = gcd(num, den);
  let rNum = num / d;
  let rDen = den / d;

  // Normalise so the denominator is always positive
  if (rDen < 0) {
    rNum = -rNum;
    rDen = -rDen;
  }

  return { num: rNum, den: rDen };
}

/**
 * Check whether two frame rates are equal after reducing both
 * to their lowest terms.
 *
 * For example `{ num: 48000, den: 2002 }` equals
 * `{ num: 24000, den: 1001 }` because both simplify to the
 * same rational value.
 *
 * @param a - First frame rate
 * @param b - Second frame rate
 * @returns `true` when the two rates represent the same value
 */
export function frameRatesEqual(a: FrameRate, b: FrameRate): boolean {
  const sa = simplifyRational(a.num, a.den);
  const sb = simplifyRational(b.num, b.den);
  return sa.num === sb.num && sa.den === sb.den;
}

/**
 * Scale a frame count by a rational factor `(scaleNum / scaleDen)`.
 *
 * The result is **rounded to the nearest integer** so that callers
 * always get a whole frame count back.  This is the standard
 * approach for frame-accurate rate conversions (e.g. converting a
 * frame index from 24000/1001 to 30000/1001).
 *
 * @param frames   - Source frame count
 * @param scaleNum - Numerator of the scale factor
 * @param scaleDen - Denominator of the scale factor (must not be 0)
 * @returns The scaled frame count, rounded to the nearest integer
 * @throws {Error} If `scaleDen` is 0
 */
export function scaleFrames(
  frames: number,
  scaleNum: number,
  scaleDen: number,
): number {
  if (scaleDen === 0) {
    throw new Error('Scale denominator must not be zero');
  }
  return Math.round((frames * scaleNum) / scaleDen);
}
