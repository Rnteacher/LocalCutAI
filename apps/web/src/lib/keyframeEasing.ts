export type WebKeyframeEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'bezier';

export interface WebBezierHandles {
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

function sampleCubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number,
): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;

  const bezierX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const bezierXDerivative = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  let s = t;
  for (let i = 0; i < 8; i++) {
    const xError = bezierX(s) - t;
    if (Math.abs(xError) < 1e-7) break;
    const d = bezierXDerivative(s);
    if (Math.abs(d) < 1e-7) break;
    s -= xError / d;
  }

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

  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  return ((ay * s + by) * s + cy) * s;
}

export function applyKeyframeEasing(
  t: number,
  easing: WebKeyframeEasing,
  handles?: WebBezierHandles,
): number {
  const clamped = Math.max(0, Math.min(1, t));

  switch (easing) {
    case 'ease-in':
      return clamped * clamped;
    case 'ease-out':
      return 1 - (1 - clamped) * (1 - clamped);
    case 'ease-in-out':
      return clamped < 0.5
        ? 2 * clamped * clamped
        : 1 - 2 * (1 - clamped) * (1 - clamped);
    case 'bezier': {
      if (!handles) return clamped;
      return sampleCubicBezier(
        handles.outX,
        handles.outY,
        handles.inX,
        handles.inY,
        clamped,
      );
    }
    case 'linear':
    default:
      return clamped;
  }
}

