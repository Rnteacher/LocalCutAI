import type { ID, TimeValue } from './project.js';

export type EasingType = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'bezier';

export type AnimatableProperty =
  | 'opacity'
  | 'speed'
  | 'volume'
  | 'pan'
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'hue'
  | 'vignette'
  | 'transform.positionX'
  | 'transform.positionY'
  | 'transform.scaleX'
  | 'transform.scaleY'
  | 'transform.rotation'
  | 'transform.anchorX'
  | 'transform.anchorY'
  | 'mask.opacity'
  | 'mask.feather'
  | 'mask.expansion';

export interface Keyframe {
  id: ID;
  clipId: ID;
  property: AnimatableProperty;
  time: TimeValue; // Relative to clip start
  value: number;
  easing: EasingType;
  bezierHandles?: {
    // Only when easing = 'bezier'
    inX: number;
    inY: number;
    outX: number;
    outY: number;
  };
}
