/**
 * @module keyframeEval
 *
 * Evaluates keyframed (animated) properties on clips at a given local time.
 *
 * The module supports all {@link EasingType} curves including cubic-bezier with
 * user-defined control handles, and falls back to the clip's static property
 * value when no keyframes are present.
 */

import type { TimeValue } from '../types/project.js';
import type { AnimatableProperty, EasingType, Keyframe } from '../types/keyframe.js';
import type { ClipItem } from '../types/timeline.js';
import { compareTimeValues, timeValueToSeconds } from '../utils/timecode.js';

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/**
 * Apply an easing function to a normalized parameter `t` in the range [0, 1].
 *
 * Supported easing types:
 * - **linear** -- identity (`t`).
 * - **ease-in** -- quadratic ease-in (`t^2`).
 * - **ease-out** -- quadratic ease-out (`1 - (1-t)^2`).
 * - **ease-in-out** -- quadratic ease-in-out.
 * - **bezier** -- cubic bezier solved from the provided control handles.
 *
 * @param t       - Normalised time in [0, 1].
 * @param easing  - The easing type to apply.
 * @param handles - Required when `easing` is `'bezier'`. Defines the two
 *                  control points of the cubic bezier curve.
 * @returns The eased value, typically in [0, 1] (bezier curves may overshoot).
 */
export function applyEasing(
  t: number,
  easing: EasingType,
  handles?: { inX: number; inY: number; outX: number; outY: number },
): number {
  // Clamp to avoid floating-point overshoot on boundaries.
  const ct = Math.max(0, Math.min(1, t));

  switch (easing) {
    case 'linear':
      return ct;

    case 'ease-in':
      return ct * ct;

    case 'ease-out':
      return 1 - (1 - ct) * (1 - ct);

    case 'ease-in-out':
      return ct < 0.5
        ? 2 * ct * ct
        : 1 - 2 * (1 - ct) * (1 - ct);

    case 'bezier': {
      if (!handles) return ct; // Degrade gracefully to linear.
      return sampleCubicBezier(handles.outX, handles.outY, handles.inX, handles.inY, ct);
    }

    default:
      return ct;
  }
}

// ---------------------------------------------------------------------------
// Cubic bezier helper (De Casteljau / Newton-Raphson)
// ---------------------------------------------------------------------------

/**
 * Evaluate a 1-D cubic bezier defined by control points
 * `(0,0), (x1,y1), (x2,y2), (1,1)` at parameter `t` (the *time* axis).
 *
 * We first solve for the curve parameter `s` such that `B_x(s) = t` using a
 * combination of Newton-Raphson and bisection, then return `B_y(s)`.
 */
function sampleCubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number,
): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  // Bernstein basis coefficients for the X axis.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;

  const bezierX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const bezierXDerivative = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  // Newton-Raphson to find s where bezierX(s) = t.
  let s = t; // Initial guess.
  for (let i = 0; i < 8; i++) {
    const xError = bezierX(s) - t;
    if (Math.abs(xError) < 1e-7) break;
    const d = bezierXDerivative(s);
    if (Math.abs(d) < 1e-7) break;
    s -= xError / d;
  }

  // Clamp to [0,1] then fall back to bisection if Newton diverged.
  s = Math.max(0, Math.min(1, s));
  if (Math.abs(bezierX(s) - t) > 1e-5) {
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 20; i++) {
      const x = bezierX(s);
      if (Math.abs(x - t) < 1e-7) break;
      if (x < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
  }

  // Evaluate Y at the found parameter.
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  return ((ay * s + by) * s + cy) * s;
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Linearly interpolate between two keyframe values using the easing curve
 * defined on the *source* (from) keyframe.
 *
 * @param from - The keyframe at or before the current time.
 * @param to   - The keyframe at or after the current time.
 * @param t    - Normalised position between the two keyframes [0, 1].
 * @returns The interpolated value.
 */
export function interpolate(from: Keyframe, to: Keyframe, t: number): number {
  const easedT = applyEasing(t, from.easing, from.bezierHandles);
  return from.value + (to.value - from.value) * easedT;
}

// ---------------------------------------------------------------------------
// Property evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the value of a single animatable property at a given clip-local
 * time by inspecting the provided keyframe list.
 *
 * Behaviour:
 * - **No keyframes** -- returns `defaultValue`.
 * - **Single keyframe** -- returns that keyframe's value regardless of time.
 * - **Before first keyframe** -- holds the first keyframe's value.
 * - **After last keyframe** -- holds the last keyframe's value.
 * - **Between two keyframes** -- interpolates using easing.
 *
 * @param keyframes    - All keyframes belonging to the clip (may contain
 *                       multiple properties; only those matching `property`
 *                       are used).
 * @param property     - The property to evaluate.
 * @param localTime    - Time relative to the clip start.
 * @param defaultValue - Fallback when there are no keyframes for this
 *                       property.
 * @returns The evaluated numeric value.
 */
export function evaluateKeyframes(
  keyframes: Keyframe[],
  property: AnimatableProperty,
  localTime: TimeValue,
  defaultValue: number,
): number {
  // Filter to the relevant property and sort by time.
  const relevant = keyframes
    .filter((kf) => kf.property === property)
    .sort((a, b) => compareTimeValues(a.time, b.time));

  if (relevant.length === 0) return defaultValue;
  if (relevant.length === 1) return relevant[0].value;

  // Before first keyframe -- hold first value.
  if (compareTimeValues(localTime, relevant[0].time) <= 0) {
    return relevant[0].value;
  }

  // After last keyframe -- hold last value.
  const last = relevant[relevant.length - 1];
  if (compareTimeValues(localTime, last.time) >= 0) {
    return last.value;
  }

  // Find the surrounding pair.
  for (let i = 0; i < relevant.length - 1; i++) {
    const from = relevant[i];
    const to = relevant[i + 1];

    if (
      compareTimeValues(localTime, from.time) >= 0 &&
      compareTimeValues(localTime, to.time) <= 0
    ) {
      const fromSec = timeValueToSeconds(from.time);
      const toSec = timeValueToSeconds(to.time);
      const localSec = timeValueToSeconds(localTime);

      const span = toSec - fromSec;
      const t = span === 0 ? 0 : (localSec - fromSec) / span;

      return interpolate(from, to, t);
    }
  }

  // Should be unreachable, but return the default to be safe.
  return defaultValue;
}

// ---------------------------------------------------------------------------
// Convenience: resolve a property directly from a clip
// ---------------------------------------------------------------------------

/**
 * Map an {@link AnimatableProperty} name to the static (non-animated) default
 * value stored on the clip.
 */
function getDefaultForProperty(clip: ClipItem, property: AnimatableProperty): number {
  switch (property) {
    case 'opacity':
      return clip.opacity;
    case 'speed':
      return clip.speed ?? 1;
    case 'volume':
      return clip.volume;
    case 'pan':
      return clip.pan;
    case 'brightness':
      return clip.brightness ?? 1;
    case 'contrast':
      return clip.contrast ?? 1;
    case 'saturation':
      return clip.saturation ?? 1;
    case 'hue':
      return clip.hue ?? 0;
    case 'vignette':
      return clip.vignette ?? 0;
    case 'transform.positionX':
      return clip.transform.positionX;
    case 'transform.positionY':
      return clip.transform.positionY;
    case 'transform.scaleX':
      return clip.transform.scaleX;
    case 'transform.scaleY':
      return clip.transform.scaleY;
    case 'transform.rotation':
      return clip.transform.rotation;
    case 'transform.anchorX':
      return clip.transform.anchorX;
    case 'transform.anchorY':
      return clip.transform.anchorY;
    case 'mask.opacity':
      return 1;
    case 'mask.feather':
      return 0;
    case 'mask.expansion':
      return 0;
    default:
      return 0;
  }
}

/**
 * High-level helper to get the animated value of any property on a clip at a
 * given local time.
 *
 * This combines keyframe evaluation with the clip's built-in default value so
 * callers do not need to inspect both independently.
 *
 * @param clip      - The clip to query.
 * @param property  - The property whose value to resolve.
 * @param localTime - Time relative to the clip start.
 * @returns The resolved numeric value (may be animated or static).
 */
export function getPropertyValue(
  clip: ClipItem,
  property: AnimatableProperty,
  localTime: TimeValue,
): number {
  const defaultValue = getDefaultForProperty(clip, property);
  return evaluateKeyframes(clip.keyframes, property, localTime, defaultValue);
}
