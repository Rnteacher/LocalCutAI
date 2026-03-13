import type { TimelineClipData, TimelineKeyframeData } from '../stores/projectStore.js';
import { applySegmentKeyframeEasing } from './keyframeEasing.js';

export type ClipNumericKeyframeProperty = TimelineKeyframeData['property'];

export function evaluateClipNumericKeyframe(
  clip: TimelineClipData,
  property: ClipNumericKeyframeProperty,
  clipLocalFrame: number,
  defaultValue: number,
): number {
  const source = (clip.keyframes ?? [])
    .filter((kf) => kf.property === property)
    .sort((a, b) => a.frame - b.frame);

  if (source.length === 0) return defaultValue;
  if (source.length === 1) return source[0].value;

  const frame = Math.max(0, clipLocalFrame);
  if (frame <= source[0].frame) return source[0].value;
  const last = source[source.length - 1];
  if (frame >= last.frame) return last.value;

  for (let i = 0; i < source.length - 1; i++) {
    const from = source[i];
    const to = source[i + 1];
    if (frame < from.frame || frame > to.frame) continue;
    const span = Math.max(1e-6, to.frame - from.frame);
    const t = (frame - from.frame) / span;
    const eased = applySegmentKeyframeEasing(
      t,
      from.easing,
      from.bezierHandles,
      to.easing,
      to.bezierHandles,
    );
    return from.value + (to.value - from.value) * eased;
  }

  return defaultValue;
}

export function resolveClipSourceFrameAtLocalFrame(
  clip: TimelineClipData,
  clipLocalFrame: number,
): number {
  const local = Math.max(0, clipLocalFrame);
  const sourceIn = clip.sourceInFrame ?? 0;
  const inferredOut = sourceIn + Math.max(1, clip.durationFrames);
  const sourceOut = Math.max(sourceIn + 1, clip.sourceOutFrame ?? inferredOut);

  const rawDefaultSpeed = clip.speed ?? 1;
  const defaultSpeed =
    Math.abs(rawDefaultSpeed) < 0.0001 ? (rawDefaultSpeed < 0 ? -0.0001 : 0.0001) : rawDefaultSpeed;
  const startSpeed = evaluateClipNumericKeyframe(clip, 'speed', 0, defaultSpeed);
  const startFrame = startSpeed >= 0 ? sourceIn : sourceOut - 1;

  if (local <= 0) {
    return Math.max(sourceIn, Math.min(sourceOut - 1, startFrame));
  }

  // Numerically integrate animated speed over clip-local time.
  const sampleCount = Math.max(1, Math.min(320, Math.ceil(local / 3)));
  const dt = local / sampleCount;
  let integratedFrames = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sampleFrame = (i + 0.5) * dt;
    const speed = evaluateClipNumericKeyframe(clip, 'speed', sampleFrame, defaultSpeed);
    integratedFrames += speed * dt;
  }

  const sourceFrame = startFrame + integratedFrames;
  return Math.max(sourceIn, Math.min(sourceOut - 1, sourceFrame));
}

export function resolveClipSourceTimeSec(
  clip: TimelineClipData,
  clipLocalFrame: number,
  fps: number,
): number {
  const sourceFrame = resolveClipSourceFrameAtLocalFrame(clip, clipLocalFrame);
  return sourceFrame / Math.max(1, fps);
}
