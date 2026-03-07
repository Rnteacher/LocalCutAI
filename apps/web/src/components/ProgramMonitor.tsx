import { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import type {
  MaskPoint,
  TimelineClipData,
  TimelineTrackData,
  TimelineKeyframeData,
} from '../stores/projectStore.js';
import { api } from '../lib/api.js';
import { adaptSequence } from '../lib/timelineAdapter.js';
import { buildCompositionPlan } from '../lib/core.js';
import { applyKeyframeEasing } from '../lib/keyframeEasing.js';
import { WebGL2LayerComposer } from '../lib/webgl/composer.js';

interface ActiveLayer {
  clip: TimelineClipData;
  trackIndex: number;
  clipLocalFrame: number;
  sourceTimeSec: number;
  opacity: number;
  positionX: number;
  positionY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  anchorX: number;
  anchorY: number;
  blendMode: TimelineClipData['blendMode'];
  transitionProgress: number | null;
  transitionType: 'cross-dissolve' | 'fade-black' | null;
  transitionPhase: 'in' | 'out' | null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayerGeometry {
  matrix: DOMMatrix;
  inverse: DOMMatrix;
  drawX: number;
  drawY: number;
  drawWidth: number;
  drawHeight: number;
  sourceWidth: number;
  sourceHeight: number;
}

interface MaskOverlayInfo {
  clipId: string;
  maskId: string;
  frame: number;
  points: MaskPoint[];
  normalized: boolean;
  geometry: LayerGeometry;
  screenPoints: Array<{ x: number; y: number }>;
  screenIn: Array<{ x: number; y: number }>;
  screenOut: Array<{ x: number; y: number }>;
  centerMask: { x: number; y: number };
  centerScreen: { x: number; y: number };
  scaleHandleScreen: { x: number; y: number };
  rotateHandleScreen: { x: number; y: number };
  gizmoRadius: number;
  closed: boolean;
}

interface RendererStatus {
  backend: 'canvas2d' | 'webgl2';
  reason: string | null;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatTimecode(frame: number, fps: number): string {
  const safeFps = Math.max(1, Math.round(fps));
  const totalSec = Math.floor(frame / safeFps);
  const ff = frame % safeFps;
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

function parseTimecodeToFrame(value: string, fps: number): number | null {
  const m = value.trim().match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return null;
  const hh = m[1];
  const mm = m[2];
  const ss = m[3];
  const ff = m[4];
  const safeFps = Math.max(1, Math.round(fps));
  const frame =
    Number(hh) * 3600 * safeFps + Number(mm) * 60 * safeFps + Number(ss) * safeFps + Number(ff);
  if (!Number.isFinite(frame)) return null;
  return Math.max(0, frame);
}

function resolveTransitionVisualMix(layer: ActiveLayer): { contentOpacity: number; blackOpacity: number } {
  if (!layer.transitionType || layer.transitionProgress == null || !layer.transitionPhase) {
    return { contentOpacity: 1, blackOpacity: 0 };
  }

  const t = Math.max(0, Math.min(1, layer.transitionProgress));
  const contentOpacity = layer.transitionPhase === 'in' ? t : 1 - t;

  if (layer.transitionType === 'fade-black') {
    return {
      contentOpacity,
      blackOpacity: 1 - contentOpacity,
    };
  }

  return { contentOpacity, blackOpacity: 0 };
}

function frameFitRect(
  canvasWidth: number,
  canvasHeight: number,
  frameWidth: number,
  frameHeight: number,
): { x: number; y: number; width: number; height: number; scale: number } {
  const fw = Math.max(1, frameWidth);
  const fh = Math.max(1, frameHeight);
  const fit = Math.min(canvasWidth / fw, canvasHeight / fh);
  const width = fw * fit;
  const height = fh * fit;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
    scale: fit,
  };
}

function clientToCanvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / Math.max(1, rect.width);
  const sy = canvas.height / Math.max(1, rect.height);
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

function distancePointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2)) : 0;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return Math.hypot(dx, dy);
}

function pointInPolygon(px: number, py: number, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / Math.max(1e-6, yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function maskPointsAreNormalized(points: MaskPoint[]): boolean {
  return points.every(
    (p) =>
      Math.abs(p.x) <= 1.5 &&
      Math.abs(p.y) <= 1.5 &&
      Math.abs(p.inX) <= 1.5 &&
      Math.abs(p.inY) <= 1.5 &&
      Math.abs(p.outX) <= 1.5 &&
      Math.abs(p.outY) <= 1.5,
  );
}

function mapMaskPointToCanvas(
  point: MaskPoint,
  geometry: LayerGeometry,
  normalized: boolean,
): { x: number; y: number } {
  const srcW = Math.max(1, geometry.sourceWidth);
  const srcH = Math.max(1, geometry.sourceHeight);
  const baseX = geometry.drawX + (normalized ? point.x : point.x / srcW) * geometry.drawWidth;
  const baseY = geometry.drawY + (normalized ? point.y : point.y / srcH) * geometry.drawHeight;
  const p = geometry.matrix.transformPoint(new DOMPoint(baseX, baseY));
  return { x: p.x, y: p.y };
}

function mapCanvasToMaskPoint(
  x: number,
  y: number,
  geometry: LayerGeometry,
  normalized: boolean,
): { x: number; y: number } {
  const p = geometry.inverse.transformPoint(new DOMPoint(x, y));
  const nx = (p.x - geometry.drawX) / Math.max(1e-6, geometry.drawWidth);
  const ny = (p.y - geometry.drawY) / Math.max(1e-6, geometry.drawHeight);
  if (normalized) {
    return { x: nx, y: ny };
  }
  return {
    x: nx * geometry.sourceWidth,
    y: ny * geometry.sourceHeight,
  };
}

function safeScale(value: number): number {
  if (Math.abs(value) < 0.01) return value < 0 ? -0.01 : 0.01;
  return value;
}

function transformMaskPoints(
  points: MaskPoint[],
  centerX: number,
  centerY: number,
  options: {
    translateX?: number;
    translateY?: number;
    scale?: number;
    rotateRad?: number;
  },
): MaskPoint[] {
  const translateX = options.translateX ?? 0;
  const translateY = options.translateY ?? 0;
  const scale = options.scale ?? 1;
  const rotateRad = options.rotateRad ?? 0;
  const cos = Math.cos(rotateRad);
  const sin = Math.sin(rotateRad);

  const mapCoord = (x: number, y: number): { x: number; y: number } => {
    const localX = (x - centerX) * scale;
    const localY = (y - centerY) * scale;
    const rotX = localX * cos - localY * sin;
    const rotY = localX * sin + localY * cos;
    return {
      x: centerX + rotX + translateX,
      y: centerY + rotY + translateY,
    };
  };

  return points.map((pt) => {
    const p = mapCoord(pt.x, pt.y);
    const inP = mapCoord(pt.inX, pt.inY);
    const outP = mapCoord(pt.outX, pt.outY);
    return {
      x: p.x,
      y: p.y,
      inX: inP.x,
      inY: inP.y,
      outX: outP.x,
      outY: outP.y,
    };
  });
}

function blendModeToComposite(mode: TimelineClipData['blendMode']): GlobalCompositeOperation {
  switch (mode) {
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
    case 'add':
      return 'lighter';
    case 'silhouette-alpha':
    case 'silhouette-luma':
      return 'destination-out';
    case 'normal':
    default:
      return 'source-over';
  }
}

function resolveGeneratorColor(clip: TimelineClipData): string | null {
  const generator = clip.generator;
  if (!generator) return null;
  if (generator.kind === 'black-video') return '#000000';
  if (generator.kind === 'color-matte') {
    if (typeof generator.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(generator.color)) {
      return generator.color;
    }
    return '#000000';
  }
  return null;
}

function evaluateClipNumericKeyframe(
  clip: TimelineClipData,
  property: 'mask.opacity' | 'mask.feather' | 'mask.expansion',
  clipLocalFrame: number,
  defaultValue: number,
): number {
  const source = (clip.keyframes ?? [])
    .filter((kf) => kf.property === property)
    .sort((a, b) => a.frame - b.frame);
  if (source.length === 0) return defaultValue;
  if (source.length === 1) return source[0].value;
  if (clipLocalFrame <= source[0].frame) return source[0].value;
  const last = source[source.length - 1];
  if (clipLocalFrame >= last.frame) return last.value;

  for (let i = 0; i < source.length - 1; i++) {
    const from = source[i];
    const to = source[i + 1];
    if (clipLocalFrame < from.frame || clipLocalFrame > to.frame) continue;
    const span = Math.max(1, to.frame - from.frame);
    const t = (clipLocalFrame - from.frame) / span;
    const eased = applyKeyframeEasing(t, from.easing, from.bezierHandles);
    return from.value + (to.value - from.value) * eased;
  }
  return defaultValue;
}

function resolveMaskShapeAtFrame(
  mask: NonNullable<TimelineClipData['masks']>[number],
  clipLocalFrame: number,
): MaskPoint[] {
  const keyframes = [...(mask.keyframes ?? [])].sort((a, b) => a.frame - b.frame);
  if (keyframes.length === 0) return [];
  if (keyframes.length === 1) {
    return keyframes[0].points.map((p) => ({ ...p }));
  }

  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (clipLocalFrame <= first.frame) {
    return first.points.map((p) => ({ ...p }));
  }
  if (clipLocalFrame >= last.frame) {
    return last.points.map((p) => ({ ...p }));
  }

  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (clipLocalFrame < a.frame || clipLocalFrame > b.frame) continue;
    const t = (clipLocalFrame - a.frame) / Math.max(1, b.frame - a.frame);
    if (a.points.length !== b.points.length) {
      return (t < 0.5 ? a.points : b.points).map((p) => ({ ...p }));
    }
    return a.points.map((ap, idx) => {
      const bp = b.points[idx];
      return {
        x: ap.x + (bp.x - ap.x) * t,
        y: ap.y + (bp.y - ap.y) * t,
        inX: ap.inX + (bp.inX - ap.inX) * t,
        inY: ap.inY + (bp.inY - ap.inY) * t,
        outX: ap.outX + (bp.outX - ap.outX) * t,
        outY: ap.outY + (bp.outY - ap.outY) * t,
      };
    });
  }

  return first.points.map((p) => ({ ...p }));
}

function drawMaskPath(
  ctx: CanvasRenderingContext2D,
  points: MaskPoint[],
  options: {
    drawX: number;
    drawY: number;
    drawWidth: number;
    drawHeight: number;
    sourceWidth: number;
    sourceHeight: number;
    closed: boolean;
  },
): void {
  if (points.length < 2) return;
  const normalized = points.every(
    (p) =>
      Math.abs(p.x) <= 1.5 &&
      Math.abs(p.y) <= 1.5 &&
      Math.abs(p.inX) <= 1.5 &&
      Math.abs(p.inY) <= 1.5 &&
      Math.abs(p.outX) <= 1.5 &&
      Math.abs(p.outY) <= 1.5,
  );
  const srcW = Math.max(1, options.sourceWidth);
  const srcH = Math.max(1, options.sourceHeight);
  const mapX = (v: number) =>
    options.drawX + (normalized ? v : v / srcW) * options.drawWidth;
  const mapY = (v: number) =>
    options.drawY + (normalized ? v : v / srcH) * options.drawHeight;

  ctx.beginPath();
  ctx.moveTo(mapX(points[0].x), mapY(points[0].y));
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    ctx.bezierCurveTo(
      mapX(prev.outX),
      mapY(prev.outY),
      mapX(curr.inX),
      mapY(curr.inY),
      mapX(curr.x),
      mapY(curr.y),
    );
  }
  if (options.closed) {
    const first = points[0];
    const last = points[points.length - 1];
    ctx.bezierCurveTo(
      mapX(last.outX),
      mapY(last.outY),
      mapX(first.inX),
      mapY(first.inY),
      mapX(first.x),
      mapY(first.y),
    );
    ctx.closePath();
  }
}

function applyClipMasks(
  layerCtx: CanvasRenderingContext2D,
  maskCtx: CanvasRenderingContext2D,
  layerClip: TimelineClipData,
  clipLocalFrame: number,
  geometry: {
    drawX: number;
    drawY: number;
    drawWidth: number;
    drawHeight: number;
    sourceWidth: number;
    sourceHeight: number;
  },
): void {
  const masks = layerClip.masks ?? [];
  if (!masks.length) return;

  const active = masks
    .map((mask) => ({ mask, points: resolveMaskShapeAtFrame(mask, clipLocalFrame) }))
    .filter((m) => m.points.length >= 2);
  if (!active.length) return;

  const w = maskCtx.canvas.width;
  const h = maskCtx.canvas.height;
  const sourceScale = (geometry.drawWidth / Math.max(1, geometry.sourceWidth) + geometry.drawHeight / Math.max(1, geometry.sourceHeight)) / 2;
  const transform = layerCtx.getTransform();
  const keyframedMaskOpacity = Math.max(
    0,
    Math.min(1, evaluateClipNumericKeyframe(layerClip, 'mask.opacity', clipLocalFrame, 1)),
  );
  const keyframedMaskFeather = Math.max(
    0,
    evaluateClipNumericKeyframe(layerClip, 'mask.feather', clipLocalFrame, 0),
  );
  const keyframedMaskExpansion = evaluateClipNumericKeyframe(
    layerClip,
    'mask.expansion',
    clipLocalFrame,
    0,
  );

  maskCtx.save();
  maskCtx.setTransform(1, 0, 0, 1, 0, 0);
  maskCtx.clearRect(0, 0, w, h);
  maskCtx.setTransform(transform);

  const effectiveMode = (
    mode: NonNullable<TimelineClipData['masks']>[number]['mode'],
    invert: boolean,
  ): 'add' | 'subtract' | 'intersect' => {
    if (!invert) return mode;
    if (mode === 'add') return 'subtract';
    if (mode === 'subtract') return 'add';
    return 'intersect';
  };

  const addMasks = active.filter((m) => effectiveMode(m.mask.mode, m.mask.invert) === 'add');
  const intersectMasks = active.filter(
    (m) => effectiveMode(m.mask.mode, m.mask.invert) === 'intersect',
  );
  const subtractMasks = active.filter(
    (m) => effectiveMode(m.mask.mode, m.mask.invert) === 'subtract',
  );

  if (addMasks.length === 0) {
    maskCtx.globalCompositeOperation = 'source-over';
    maskCtx.globalAlpha = 1;
    maskCtx.filter = 'none';
    maskCtx.fillStyle = '#fff';
    maskCtx.fillRect(0, 0, w, h);
  }

  const paintMask = (
    entry: (typeof active)[number],
    composite: GlobalCompositeOperation,
  ) => {
    const opacity = Math.max(
      0,
      Math.min(1, (entry.mask.opacity ?? 1) * keyframedMaskOpacity),
    );
    if (opacity <= 0.0001) return;
    const featherPx = Math.max(0, (entry.mask.feather + keyframedMaskFeather) * sourceScale);
    const expansionPx = Math.max(
      0,
      (entry.mask.expansion + keyframedMaskExpansion) * sourceScale,
    );
    maskCtx.globalCompositeOperation = composite;
    maskCtx.globalAlpha = opacity;
    maskCtx.filter = featherPx > 0.1 ? `blur(${featherPx.toFixed(2)}px)` : 'none';
    maskCtx.fillStyle = '#fff';
    maskCtx.strokeStyle = '#fff';
    drawMaskPath(maskCtx, entry.points, {
      drawX: geometry.drawX,
      drawY: geometry.drawY,
      drawWidth: geometry.drawWidth,
      drawHeight: geometry.drawHeight,
      sourceWidth: geometry.sourceWidth,
      sourceHeight: geometry.sourceHeight,
      closed: entry.mask.closed,
    });
    if (entry.mask.closed) {
      maskCtx.fill();
    } else {
      maskCtx.lineWidth = Math.max(1, 2 + expansionPx * 2);
      maskCtx.lineJoin = 'round';
      maskCtx.lineCap = 'round';
      maskCtx.stroke();
    }
    if (expansionPx > 0.1) {
      maskCtx.lineWidth = Math.max(1, expansionPx * 2);
      maskCtx.lineJoin = 'round';
      maskCtx.lineCap = 'round';
      maskCtx.stroke();
    }
  };

  for (const entry of addMasks) paintMask(entry, 'source-over');
  for (const entry of intersectMasks) paintMask(entry, 'destination-in');
  for (const entry of subtractMasks) paintMask(entry, 'destination-out');

  maskCtx.restore();

  layerCtx.save();
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.globalCompositeOperation = 'destination-in';
  layerCtx.globalAlpha = 1;
  layerCtx.filter = 'none';
  layerCtx.drawImage(maskCtx.canvas, 0, 0);
  layerCtx.restore();
}

export function ProgramMonitor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewfinderRef = useRef<HTMLDivElement>(null);
  const warnedClipIdsRef = useRef(new Set<string>());
  const videoByClipIdRef = useRef(new Map<string, HTMLVideoElement>());
  const seekStateRef = useRef(
    new Map<string, { seeking: boolean; desired: number; lastSeekAt: number }>(),
  );
  const lastPlayingRef = useRef(false);
  const adjustmentCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const layerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglComposerRef = useRef<WebGL2LayerComposer | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [renderTick, setRenderTick] = useState(0);
  const [timeInput, setTimeInput] = useState('00:00:00:00');
  const vfDragModeRef = useRef<'playhead' | 'in' | 'out' | 'range' | null>(null);
  const vfRangeDragRef = useRef<{ inFrame: number; outFrame: number; anchorOffset: number } | null>(
    null,
  );

  const dragRef = useRef<{
    mode: 'move' | 'scale';
    clipId: string;
    clipLocalFrame: number;
    startX: number;
    startY: number;
    posX: number;
    posY: number;
    scaleX: number;
    scaleY: number;
  } | null>(null);

  const maskOverlayRef = useRef<MaskOverlayInfo | null>(null);
  const maskDragRef = useRef<{
    mode:
      | 'point'
      | 'point-in-handle'
      | 'point-out-handle'
      | 'shape'
      | 'shape-scale'
      | 'shape-rotate';
    clipId: string;
    maskId: string;
    keyframeId: string;
    frame: number;
    pointIndex: number;
    startMaskX: number;
    startMaskY: number;
    centerMaskX: number;
    centerMaskY: number;
    centerScreenX: number;
    centerScreenY: number;
    startScreenDistance: number;
    startScreenAngle: number;
    basePoints: MaskPoint[];
    points: MaskPoint[];
    normalized: boolean;
    geometry: LayerGeometry;
  } | null>(null);
  const maskPreviewRef = useRef<{
    clipId: string;
    maskId: string;
    frame: number;
    points: MaskPoint[];
  } | null>(null);

  const transformPreviewRef = useRef<{
    clipId: string;
    positionX: number;
    positionY: number;
    scaleX: number;
    scaleY: number;
  } | null>(null);

  const [maskEditMode, setMaskEditMode] = useState(false);
  const [maskOnionSkinEnabled, setMaskOnionSkinEnabled] = useState(true);
  const [activeMaskId, setActiveMaskId] = useState<string | null>(null);
  const [selectedMaskPoint, setSelectedMaskPoint] = useState<{
    clipId: string;
    maskId: string;
    pointIndex: number;
  } | null>(null);
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>({
    backend: 'canvas2d',
    reason: null,
  });
  const rendererStatusRef = useRef<RendererStatus>({
    backend: 'canvas2d',
    reason: null,
  });
  const [renderCostMs, setRenderCostMs] = useState(0);
  const renderCostRef = useRef({ value: 0, lastUpdateAt: 0 });

  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const totalFrames = usePlaybackStore((s) => s.totalFrames);
  const fps = usePlaybackStore((s) => s.fps);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const shuttleSpeed = usePlaybackStore((s) => s.shuttleSpeed);
  const togglePlayPause = usePlaybackStore((s) => s.togglePlayPause);
  const stepForward = usePlaybackStore((s) => s.stepForward);
  const stepBackward = usePlaybackStore((s) => s.stepBackward);
  const goToStart = usePlaybackStore((s) => s.goToStart);
  const goToEnd = usePlaybackStore((s) => s.goToEnd);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const inPoint = usePlaybackStore((s) => s.inPoint);
  const outPoint = usePlaybackStore((s) => s.outPoint);
  const setInPointAt = usePlaybackStore((s) => s.setInPointAt);
  const setOutPointAt = usePlaybackStore((s) => s.setOutPointAt);
  const clearInOutPoints = usePlaybackStore((s) => s.clearInOutPoints);

  const sequences = useProjectStore((s) => s.sequences);
  const updateClipProperties = useProjectStore((s) => s.updateClipProperties);
  const upsertClipKeyframe = useProjectStore((s) => s.upsertClipKeyframe);
  const addClipMask = useProjectStore((s) => s.addClipMask);
  const upsertMaskShapeKeyframe = useProjectStore((s) => s.upsertMaskShapeKeyframe);
  const insertMaskPointAcrossKeyframes = useProjectStore((s) => s.insertMaskPointAcrossKeyframes);
  const removeMaskPointAcrossKeyframes = useProjectStore((s) => s.removeMaskPointAcrossKeyframes);
  const liftRangeByInOut = useProjectStore((s) => s.liftRangeByInOut);
  const extractRangeByInOut = useProjectStore((s) => s.extractRangeByInOut);
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const targetVideoTrackId = useSelectionStore((s) => s.targetVideoTrackId);
  const targetAudioTrackId = useSelectionStore((s) => s.targetAudioTrackId);
  const linkedSelection = useSelectionStore((s) => s.linkedSelection);
  const autoKeyframeEnabled = useSelectionStore((s) => s.autoKeyframeEnabled);
  const setAutoKeyframeEnabled = useSelectionStore((s) => s.setAutoKeyframeEnabled);
  const selectClip = useSelectionStore((s) => s.selectClip);
  const setActivePanel = useSelectionStore((s) => s.setActivePanel);
  const rendererMode = useSelectionStore((s) => s.rendererMode);
  const setRendererMode = useSelectionStore((s) => s.setRendererMode);

  const activeLayers = useMemo(() => {
    const seq = sequences[0];
    if (!seq) return [] as ActiveLayer[];
    const data = seq.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];
    if (tracks.length === 0) return [] as ActiveLayer[];

    const clipById = new Map<string, TimelineClipData>();
    const trackIndexById = new Map<string, number>();
    for (const track of tracks) {
      trackIndexById.set(track.id, track.index);
      for (const clip of track.clips) {
        clipById.set(clip.id, clip);
      }
    }

    const coreSeq = adaptSequence(
      seq.id,
      seq.projectId,
      seq.name,
      tracks,
      seq.frameRate,
      seq.resolution,
    );
    const plan = buildCompositionPlan(coreSeq, {
      frames: currentFrame,
      rate: seq.frameRate,
    });

    const resolved = plan.videoLayers
      .map((layer) => {
        const clip = clipById.get(layer.clipId);
        if (!clip) return null;
        const sourceFps = layer.sourceTime.rate.num / layer.sourceTime.rate.den;
        return {
          clip,
          trackIndex: trackIndexById.get(layer.trackId) ?? 0,
          clipLocalFrame: Math.max(
            0,
            Math.min(clip.durationFrames, currentFrame - clip.startFrame),
          ),
          sourceTimeSec: sourceFps > 0 ? layer.sourceTime.frames / sourceFps : 0,
          opacity: layer.opacity,
          positionX: layer.transform.positionX,
          positionY: layer.transform.positionY,
          scaleX: layer.transform.scaleX,
          scaleY: layer.transform.scaleY,
          rotation: layer.transform.rotation,
          anchorX: layer.transform.anchorX,
          anchorY: layer.transform.anchorY,
          blendMode: layer.blendMode,
          transitionProgress: layer.transitionProgress,
          transitionType: layer.transitionType,
          transitionPhase: layer.transitionPhase,
        } as ActiveLayer;
      })
      .filter((layer): layer is ActiveLayer => layer != null);

    resolved.sort((a, b) => b.trackIndex - a.trackIndex);
    return resolved;
  }, [sequences, currentFrame, fps]);
  const seqResolution = sequences[0]?.resolution ?? { width: 1920, height: 1080 };

  const topLayer = activeLayers.length ? activeLayers[activeLayers.length - 1] : null;
  const hasValidInOut = inPoint != null && outPoint != null && outPoint > inPoint;
  const selectionArray = useMemo(() => Array.from(selectedClipIds), [selectedClipIds]);
  const selectedActiveLayer = useMemo(
    () => activeLayers.find((l) => selectionArray.includes(l.clip.id)) ?? null,
    [activeLayers, selectionArray],
  );
  const controlledLayer = selectedActiveLayer ?? topLayer;
  const activeMask = useMemo(() => {
    const masks = controlledLayer?.clip.masks ?? [];
    if (!masks.length) return null;
    return masks.find((m) => m.id === activeMaskId) ?? masks[0] ?? null;
  }, [controlledLayer?.clip.id, controlledLayer?.clip.masks, activeMaskId]);

  useEffect(() => {
    if (!activeMask) {
      setActiveMaskId(null);
      return;
    }
    if (activeMask.id !== activeMaskId) {
      setActiveMaskId(activeMask.id);
    }
  }, [activeMask, activeMaskId]);

  useEffect(() => {
    const sel = selectedMaskPoint;
    if (!sel) return;
    if (!controlledLayer || sel.clipId !== controlledLayer.clip.id) {
      setSelectedMaskPoint(null);
      return;
    }
    if (activeMask && sel.maskId !== activeMask.id) {
      setSelectedMaskPoint(null);
    }
  }, [selectedMaskPoint, controlledLayer, activeMask]);

  useEffect(() => {
    setTimeInput(formatTimecode(currentFrame, fps));
  }, [currentFrame, fps]);

  const getOrCreateVideo = useCallback((clip: TimelineClipData): HTMLVideoElement | null => {
    if (!clip.mediaAssetId) return null;
    const cache = videoByClipIdRef.current;
    let video = cache.get(clip.id);
    if (!video) {
      video = document.createElement('video');
      video.src = api.media.fileUrl(clip.mediaAssetId);
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      const element = video;
      seekStateRef.current.set(clip.id, { seeking: false, desired: 0, lastSeekAt: 0 });
      element.onseeked = () => {
        const st = seekStateRef.current.get(clip.id);
        if (!st) {
          setRenderTick((v) => v + 1);
          return;
        }
        st.seeking = false;
        setRenderTick((v) => v + 1);
      };
      element.onloadeddata = () => setRenderTick((v) => v + 1);
      video.onerror = () => {
        if (!warnedClipIdsRef.current.has(clip.id)) {
          warnedClipIdsRef.current.add(clip.id);
          console.warn(
            '[ProgramMonitor] Failed loading media for clip',
            clip.id,
            clip.mediaAssetId,
          );
        }
      };
      cache.set(clip.id, video);
    }
    return video;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        canvas.width = Math.max(1, Math.round(entry.contentRect.width));
        canvas.height = Math.max(1, Math.round(entry.contentRect.height));
        setRenderTick((v) => v + 1);
      }
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      webglComposerRef.current?.dispose();
      webglComposerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const activeIds = new Set(activeLayers.map((l) => l.clip.id));
    for (const [id, video] of videoByClipIdRef.current) {
      if (!activeIds.has(id)) video.pause();
    }
  }, [activeLayers]);

  const getDisplayRect = useCallback(
    (layer: ActiveLayer): Rect | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const video = layer.clip.mediaAssetId ? getOrCreateVideo(layer.clip) : null;
      if (layer.clip.mediaAssetId && (!video || video.readyState < 1)) return null;

      const frame = frameFitRect(
        canvas.width,
        canvas.height,
        seqResolution.width,
        seqResolution.height,
      );
      const vw = video?.videoWidth || seqResolution.width;
      const vh = video?.videoHeight || seqResolution.height;
      const tr =
        transformPreviewRef.current?.clipId === layer.clip.id ? transformPreviewRef.current : null;

      const px = tr?.positionX ?? layer.positionX ?? 0;
      const py = tr?.positionY ?? layer.positionY ?? 0;
      const sx = tr?.scaleX ?? layer.scaleX ?? 1;
      const sy = tr?.scaleY ?? layer.scaleY ?? 1;
      const anchorX = Math.max(0, Math.min(1, layer.anchorX ?? 0.5));
      const anchorY = Math.max(0, Math.min(1, layer.anchorY ?? 0.5));
      const anchorOffsetX = (anchorX - 0.5) * vw * frame.scale;
      const anchorOffsetY = (anchorY - 0.5) * vh * frame.scale;

      const width = vw * frame.scale * Math.abs(sx) * zoom;
      const height = vh * frame.scale * Math.abs(sy) * zoom;
      const cx = canvas.width / 2 + pan.x + (px + anchorOffsetX) * zoom;
      const cy = canvas.height / 2 + pan.y + (py + anchorOffsetY) * zoom;

      return {
        x: cx - width / 2,
        y: cy - height / 2,
        width,
        height,
      };
    },
    [getOrCreateVideo, zoom, pan, seqResolution.width, seqResolution.height],
  );

  const getLayerGeometry = useCallback(
    (layer: ActiveLayer): LayerGeometry | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const frame = frameFitRect(
        canvas.width,
        canvas.height,
        seqResolution.width,
        seqResolution.height,
      );
      const video = layer.clip.mediaAssetId ? getOrCreateVideo(layer.clip) : null;
      const sourceWidth = video?.videoWidth || seqResolution.width;
      const sourceHeight = video?.videoHeight || seqResolution.height;
      const drawWidth = sourceWidth * frame.scale;
      const drawHeight = sourceHeight * frame.scale;
      const drawX = canvas.width / 2 - drawWidth / 2;
      const drawY = canvas.height / 2 - drawHeight / 2;

      const tr =
        transformPreviewRef.current?.clipId === layer.clip.id ? transformPreviewRef.current : null;
      const px = tr?.positionX ?? layer.positionX ?? 0;
      const py = tr?.positionY ?? layer.positionY ?? 0;
      const sx = tr?.scaleX ?? layer.scaleX ?? 1;
      const sy = tr?.scaleY ?? layer.scaleY ?? 1;
      const rot = layer.rotation ?? 0;
      const anchorX = Math.max(0, Math.min(1, layer.anchorX ?? 0.5));
      const anchorY = Math.max(0, Math.min(1, layer.anchorY ?? 0.5));
      const anchorOffsetX = (anchorX - 0.5) * drawWidth;
      const anchorOffsetY = (anchorY - 0.5) * drawHeight;

      const matrix = new DOMMatrix();
      matrix.translateSelf(canvas.width / 2 + pan.x, canvas.height / 2 + pan.y);
      matrix.scaleSelf(zoom, zoom);
      matrix.translateSelf(-canvas.width / 2, -canvas.height / 2);
      matrix.translateSelf(canvas.width / 2 + px, canvas.height / 2 + py);
      matrix.translateSelf(anchorOffsetX, anchorOffsetY);
      matrix.rotateSelf(rot);
      matrix.scaleSelf(safeScale(sx), safeScale(sy));
      matrix.translateSelf(-canvas.width / 2, -canvas.height / 2);

      return {
        matrix,
        inverse: matrix.inverse(),
        drawX,
        drawY,
        drawWidth,
        drawHeight,
        sourceWidth,
        sourceHeight,
      };
    },
    [
      getOrCreateVideo,
      pan.x,
      pan.y,
      zoom,
      seqResolution.width,
      seqResolution.height,
    ],
  );

  const createDefaultMaskPoints = useCallback((sourceWidth: number, sourceHeight: number): MaskPoint[] => {
    const insetX = sourceWidth * 0.15;
    const insetY = sourceHeight * 0.15;
    const left = insetX;
    const top = insetY;
    const right = sourceWidth - insetX;
    const bottom = sourceHeight - insetY;
    return [
      { x: left, y: top, inX: left, inY: top, outX: left, outY: top },
      { x: right, y: top, inX: right, inY: top, outX: right, outY: top },
      { x: right, y: bottom, inX: right, inY: bottom, outX: right, outY: bottom },
      { x: left, y: bottom, inX: left, inY: bottom, outX: left, outY: bottom },
    ];
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const renderStartedAt = performance.now();

    const syncRendererStatus = (next: RendererStatus) => {
      const prev = rendererStatusRef.current;
      if (prev.backend === next.backend && prev.reason === next.reason) return;
      rendererStatusRef.current = next;
      setRendererStatus(next);
    };

    const hasAdjustmentLayer = activeLayers.some(
      (layer) => layer.clip.generator?.kind === 'adjustment-layer',
    );

    let fallbackReason: string | null = null;
    let composer: WebGL2LayerComposer | null = null;
    let useWebgl = false;

    if (rendererMode !== 'canvas2d') {
      if (hasAdjustmentLayer) {
        fallbackReason = 'Adjustment layers force Canvas2D fallback';
      } else {
        composer = webglComposerRef.current;
        if (!composer) {
          composer = WebGL2LayerComposer.create(canvas.width, canvas.height);
          webglComposerRef.current = composer;
        }
        if (composer) {
          composer.resize(canvas.width, canvas.height);
          composer.begin();
          useWebgl = true;
        } else {
          fallbackReason = 'WebGL2 context is unavailable';
        }
      }
    }

    if (!useWebgl && rendererMode === 'webgl2' && fallbackReason == null) {
      fallbackReason = 'WebGL2 context is unavailable';
    }

    syncRendererStatus({
      backend: useWebgl ? 'webgl2' : 'canvas2d',
      reason: useWebgl ? null : fallbackReason,
    });

    let drewAny = false;
    maskOverlayRef.current = null;

    for (const layer of activeLayers) {
      const generatorColor = resolveGeneratorColor(layer.clip);
      const isAdjustmentLayer = layer.clip.generator?.kind === 'adjustment-layer';
      const needsMedia = !generatorColor && !isAdjustmentLayer;
      const video = needsMedia ? getOrCreateVideo(layer.clip) : null;

      if (needsMedia && !video) continue;

      if (video) {
        const st = seekStateRef.current.get(layer.clip.id) ?? {
          seeking: false,
          desired: layer.sourceTimeSec,
          lastSeekAt: 0,
        };
        st.desired = layer.sourceTimeSec;
        seekStateRef.current.set(layer.clip.id, st);

        const clipSpeed = layer.clip.speed ?? 1;
        const forwardShuttlePlay = isPlaying && shuttleSpeed > 0 && clipSpeed > 0;

        if (forwardShuttlePlay) {
          st.seeking = false;
          const layerRate = Math.max(0.1, Math.min(4, Math.abs(shuttleSpeed) * clipSpeed));
          video.playbackRate = layerRate;
          if (
            !lastPlayingRef.current ||
            Math.abs(video.currentTime - layer.sourceTimeSec) > Math.max(0.12, 0.08 * layerRate)
          ) {
            video.currentTime = layer.sourceTimeSec;
          }
          if (video.paused) video.play().catch(() => {});
        } else {
          video.pause();
          video.playbackRate = 1;
          const now = performance.now();
          const absSpeed = Math.max(1, Math.abs(shuttleSpeed) * Math.max(1, Math.abs(clipSpeed)));
          const minSeekInterval = Math.max(16, 40 / absSpeed);

          if (st.seeking && now - st.lastSeekAt > 180) {
            st.seeking = false;
          }

          if (
            !st.seeking &&
            now - st.lastSeekAt >= minSeekInterval &&
            Math.abs(video.currentTime - layer.sourceTimeSec) > 0.02
          ) {
            st.seeking = true;
            st.lastSeekAt = now;
            video.currentTime = layer.sourceTimeSec;
          }
        }

        if (video.readyState < 2) continue;
      }

      if (!useWebgl && !drewAny) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      const frame = frameFitRect(
        canvas.width,
        canvas.height,
        seqResolution.width,
        seqResolution.height,
      );
      const vw = video?.videoWidth || seqResolution.width;
      const vh = video?.videoHeight || seqResolution.height;
      const drawWidth = vw * frame.scale;
      const drawHeight = vh * frame.scale;

      const tr =
        transformPreviewRef.current?.clipId === layer.clip.id ? transformPreviewRef.current : null;

      const px = tr?.positionX ?? layer.positionX ?? 0;
      const py = tr?.positionY ?? layer.positionY ?? 0;
      const sx = tr?.scaleX ?? layer.scaleX ?? 1;
      const sy = tr?.scaleY ?? layer.scaleY ?? 1;
      const rot = layer.rotation ?? 0;
      const transitionMix = resolveTransitionVisualMix(layer);
      const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
      const brightness = Math.max(0, layer.clip.brightness ?? 1);
      const contrast = Math.max(0, layer.clip.contrast ?? 1);
      const saturation = Math.max(0, layer.clip.saturation ?? 1);
      const hue = layer.clip.hue ?? 0;
      const vignette = Math.max(-1, Math.min(1, layer.clip.vignette ?? 0));
      const blendMode = layer.blendMode ?? layer.clip.blendMode ?? 'normal';

      let layerCanvas = layerCanvasRef.current;
      if (!layerCanvas) {
        layerCanvas = document.createElement('canvas');
        layerCanvasRef.current = layerCanvas;
      }
      if (layerCanvas.width !== canvas.width || layerCanvas.height !== canvas.height) {
        layerCanvas.width = canvas.width;
        layerCanvas.height = canvas.height;
      }
      const layerCtx = layerCanvas.getContext('2d');
      if (!layerCtx) continue;
      layerCtx.clearRect(0, 0, layerCanvas.width, layerCanvas.height);

      const dx = canvas.width / 2 - drawWidth / 2;
      const dy = canvas.height / 2 - drawHeight / 2;
      const anchorX = Math.max(0, Math.min(1, layer.anchorX ?? 0.5));
      const anchorY = Math.max(0, Math.min(1, layer.anchorY ?? 0.5));
      const anchorOffsetX = (anchorX - 0.5) * drawWidth;
      const anchorOffsetY = (anchorY - 0.5) * drawHeight;

      layerCtx.save();
      layerCtx.translate(canvas.width / 2 + pan.x, canvas.height / 2 + pan.y);
      layerCtx.scale(zoom, zoom);
      layerCtx.translate(-canvas.width / 2, -canvas.height / 2);
      layerCtx.translate(canvas.width / 2 + px, canvas.height / 2 + py);
      layerCtx.translate(anchorOffsetX, anchorOffsetY);
      layerCtx.rotate((rot * Math.PI) / 180);
      layerCtx.scale(safeScale(sx), safeScale(sy));
      layerCtx.translate(-canvas.width / 2, -canvas.height / 2);

      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = transitionMix.contentOpacity;
      layerCtx.filter = `brightness(${brightness * 100}%) contrast(${contrast * 100}%) saturate(${saturation * 100}%) hue-rotate(${hue}deg)`;

      if (isAdjustmentLayer) {
        let off = adjustmentCanvasRef.current;
        if (!off) {
          off = document.createElement('canvas');
          adjustmentCanvasRef.current = off;
        }
        if (off.width !== canvas.width || off.height !== canvas.height) {
          off.width = canvas.width;
          off.height = canvas.height;
        }
        const octx = off.getContext('2d');
        if (octx) {
          octx.clearRect(0, 0, off.width, off.height);
          octx.drawImage(canvas, 0, 0);
          layerCtx.drawImage(off, dx, dy, drawWidth, drawHeight);
        }
      } else if (generatorColor) {
        layerCtx.fillStyle = generatorColor;
        layerCtx.fillRect(dx, dy, drawWidth, drawHeight);
      } else if (video) {
        layerCtx.drawImage(video, dx, dy, drawWidth, drawHeight);
      }

      if (Math.abs(vignette) > 0.001) {
        const inner = Math.min(drawWidth, drawHeight) * 0.2;
        const outer = Math.max(drawWidth, drawHeight) * 0.7;
        const grad = layerCtx.createRadialGradient(
          dx + drawWidth / 2,
          dy + drawHeight / 2,
          inner,
          dx + drawWidth / 2,
          dy + drawHeight / 2,
          outer,
        );
        const a = Math.min(0.9, Math.abs(vignette));
        if (vignette > 0) {
          grad.addColorStop(0, 'rgba(0,0,0,0)');
          grad.addColorStop(1, `rgba(0,0,0,${a})`);
        } else {
          grad.addColorStop(0, 'rgba(255,255,255,0)');
          grad.addColorStop(1, `rgba(255,255,255,${a})`);
        }
        layerCtx.filter = 'none';
        layerCtx.fillStyle = grad;
        layerCtx.fillRect(dx, dy, drawWidth, drawHeight);
      }

      if (transitionMix.blackOpacity > 0.0001) {
        layerCtx.filter = 'none';
        layerCtx.globalCompositeOperation = 'source-over';
        layerCtx.globalAlpha = transitionMix.blackOpacity;
        layerCtx.fillStyle = '#000000';
        layerCtx.fillRect(dx, dy, drawWidth, drawHeight);
      }

      let maskCanvas = maskCanvasRef.current;
      if (!maskCanvas) {
        maskCanvas = document.createElement('canvas');
        maskCanvasRef.current = maskCanvas;
      }
      if (maskCanvas.width !== canvas.width || maskCanvas.height !== canvas.height) {
        maskCanvas.width = canvas.width;
        maskCanvas.height = canvas.height;
      }
      const maskCtx = maskCanvas.getContext('2d');
      if (maskCtx && (layer.clip.masks?.length ?? 0) > 0) {
        applyClipMasks(layerCtx, maskCtx, layer.clip, layer.clipLocalFrame, {
          drawX: dx,
          drawY: dy,
          drawWidth,
          drawHeight,
          sourceWidth: vw,
          sourceHeight: vh,
        });
      }

      layerCtx.restore();

      if (useWebgl && composer) {
        composer.drawLayer(layerCanvas, {
          opacity,
          blendMode,
          silhouetteGamma: layer.clip.blendParams?.silhouetteGamma ?? 1,
        });
      } else {
        ctx.save();
        ctx.globalCompositeOperation = blendModeToComposite(blendMode);
        ctx.globalAlpha = opacity;
        if (blendMode === 'silhouette-luma') {
          const lumaGamma = layer.clip.blendParams?.silhouetteGamma ?? 1;
          const lumaBoost = Math.max(0.25, Math.min(4, lumaGamma));
          ctx.filter = `grayscale(100%) contrast(${100 * lumaBoost}%)`;
        } else {
          ctx.filter = 'none';
        }
        ctx.drawImage(layerCanvas, 0, 0);
        ctx.restore();
      }
      drewAny = true;
    }

    if (useWebgl && composer && drewAny) {
      composer.presentTo2d(ctx);
    }

    if (!drewAny && activeLayers.length === 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const rect = controlledLayer ? getDisplayRect(controlledLayer) : null;
    if (rect && !isPlaying) {
      ctx.save();
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.setLineDash([]);
      ctx.fillStyle = '#60a5fa';
      const hs = 8;
      ctx.fillRect(rect.x + rect.width - hs / 2, rect.y + rect.height - hs / 2, hs, hs);
      ctx.restore();
    }

    if (maskEditMode && !isPlaying && controlledLayer && activeMask) {
      const geometry = getLayerGeometry(controlledLayer);
      if (geometry) {
        const drawOnionShape = (
          shapePoints: MaskPoint[],
          strokeStyle: string,
          alpha: number,
          dash: number[],
        ) => {
          if (shapePoints.length < 2) return;
          const normalizedShape = maskPointsAreNormalized(shapePoints);
          const screen = shapePoints.map((p) => mapMaskPointToCanvas(p, geometry, normalizedShape));
          const screenInShape = shapePoints.map((p) =>
            mapMaskPointToCanvas(
              { x: p.inX, y: p.inY, inX: p.inX, inY: p.inY, outX: p.outX, outY: p.outY },
              geometry,
              normalizedShape,
            ),
          );
          const screenOutShape = shapePoints.map((p) =>
            mapMaskPointToCanvas(
              { x: p.outX, y: p.outY, inX: p.inX, inY: p.inY, outX: p.outX, outY: p.outY },
              geometry,
              normalizedShape,
            ),
          );
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = strokeStyle;
          ctx.lineWidth = 1;
          ctx.setLineDash(dash);
          ctx.beginPath();
          ctx.moveTo(screen[0].x, screen[0].y);
          for (let i = 1; i < screen.length; i++) {
            const prev = i - 1;
            ctx.bezierCurveTo(
              screenOutShape[prev].x,
              screenOutShape[prev].y,
              screenInShape[i].x,
              screenInShape[i].y,
              screen[i].x,
              screen[i].y,
            );
          }
          if (activeMask.closed) {
            const last = screen.length - 1;
            ctx.bezierCurveTo(
              screenOutShape[last].x,
              screenOutShape[last].y,
              screenInShape[0].x,
              screenInShape[0].y,
              screen[0].x,
              screen[0].y,
            );
            ctx.closePath();
          }
          ctx.stroke();
          ctx.restore();
        };

        if (maskOnionSkinEnabled) {
          const sortedMaskKeyframes = [...(activeMask.keyframes ?? [])].sort((a, b) => a.frame - b.frame);
          const localFrame = controlledLayer.clipLocalFrame;
          const prevKeyframe = [...sortedMaskKeyframes].reverse().find((kf) => kf.frame < localFrame) ?? null;
          const nextKeyframe = sortedMaskKeyframes.find((kf) => kf.frame > localFrame) ?? null;
          if (prevKeyframe) {
            drawOnionShape(prevKeyframe.points, '#38bdf8', 0.45, [3, 4]);
          }
          if (nextKeyframe) {
            drawOnionShape(nextKeyframe.points, '#f59e0b', 0.45, [3, 4]);
          }
        }

        const preview = maskPreviewRef.current;
        const hasPreview =
          preview &&
          preview.clipId === controlledLayer.clip.id &&
          preview.maskId === activeMask.id &&
          preview.frame === controlledLayer.clipLocalFrame;
        const points = hasPreview
          ? preview.points.map((p) => ({ ...p }))
          : resolveMaskShapeAtFrame(activeMask, controlledLayer.clipLocalFrame);

        if (points.length >= 2) {
          const normalized = maskPointsAreNormalized(points);
          const screenPoints = points.map((p) => mapMaskPointToCanvas(p, geometry, normalized));
          const screenIn = points.map((p) =>
            mapMaskPointToCanvas(
              { x: p.inX, y: p.inY, inX: p.inX, inY: p.inY, outX: p.outX, outY: p.outY },
              geometry,
              normalized,
            ),
          );
          const screenOut = points.map((p) =>
            mapMaskPointToCanvas(
              { x: p.outX, y: p.outY, inX: p.inX, inY: p.inY, outX: p.outX, outY: p.outY },
              geometry,
              normalized,
            ),
          );
          const selectedPointIndex =
            selectedMaskPoint?.clipId === controlledLayer.clip.id &&
            selectedMaskPoint?.maskId === activeMask.id
              ? selectedMaskPoint.pointIndex
              : -1;

          ctx.save();
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 1.4;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
          for (let i = 1; i < screenPoints.length; i++) {
            const prev = i - 1;
            ctx.bezierCurveTo(
              screenOut[prev].x,
              screenOut[prev].y,
              screenIn[i].x,
              screenIn[i].y,
              screenPoints[i].x,
              screenPoints[i].y,
            );
          }
          if (activeMask.closed) {
            const last = screenPoints.length - 1;
            ctx.bezierCurveTo(
              screenOut[last].x,
              screenOut[last].y,
              screenIn[0].x,
              screenIn[0].y,
              screenPoints[0].x,
              screenPoints[0].y,
            );
            ctx.closePath();
          }
          ctx.stroke();
          ctx.setLineDash([]);

          for (let i = 0; i < screenPoints.length; i++) {
            const isSelected = i === selectedPointIndex;
            const point = screenPoints[i];
            const inHandle = screenIn[i];
            const outHandle = screenOut[i];
            const inLen = Math.hypot(inHandle.x - point.x, inHandle.y - point.y);
            const outLen = Math.hypot(outHandle.x - point.x, outHandle.y - point.y);
            ctx.strokeStyle = isSelected ? '#93c5fd' : 'rgba(147, 197, 253, 0.5)';
            ctx.lineWidth = isSelected ? 1.2 : 0.9;
            if (inLen > 0.75) {
              ctx.beginPath();
              ctx.moveTo(point.x, point.y);
              ctx.lineTo(inHandle.x, inHandle.y);
              ctx.stroke();
            }
            if (outLen > 0.75) {
              ctx.beginPath();
              ctx.moveTo(point.x, point.y);
              ctx.lineTo(outHandle.x, outHandle.y);
              ctx.stroke();
            }
            if (inLen > 0.75 || isSelected) {
              ctx.beginPath();
              ctx.fillStyle = isSelected ? '#bfdbfe' : '#38bdf8';
              ctx.arc(inHandle.x, inHandle.y, isSelected ? 3.8 : 3.1, 0, Math.PI * 2);
              ctx.fill();
              ctx.lineWidth = 1;
              ctx.strokeStyle = '#082f49';
              ctx.stroke();
            }
            if (outLen > 0.75 || isSelected) {
              ctx.beginPath();
              ctx.fillStyle = isSelected ? '#fed7aa' : '#f59e0b';
              ctx.arc(outHandle.x, outHandle.y, isSelected ? 3.8 : 3.1, 0, Math.PI * 2);
              ctx.fill();
              ctx.lineWidth = 1;
              ctx.strokeStyle = '#1c1917';
              ctx.stroke();
            }
          }

          for (let i = 0; i < screenPoints.length; i++) {
            const isSelected = i === selectedPointIndex;
            ctx.beginPath();
            ctx.fillStyle = isSelected ? '#fef08a' : '#67e8f9';
            ctx.arc(screenPoints[i].x, screenPoints[i].y, isSelected ? 5 : 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#082f49';
            ctx.stroke();
          }

          const centerMask = points.reduce(
            (acc, pt) => ({ x: acc.x + pt.x, y: acc.y + pt.y }),
            { x: 0, y: 0 },
          );
          centerMask.x /= Math.max(1, points.length);
          centerMask.y /= Math.max(1, points.length);
          const centerScreen = screenPoints.reduce(
            (acc, pt) => ({ x: acc.x + pt.x, y: acc.y + pt.y }),
            { x: 0, y: 0 },
          );
          centerScreen.x /= Math.max(1, screenPoints.length);
          centerScreen.y /= Math.max(1, screenPoints.length);
          const boundsRadius = screenPoints.reduce((max, pt) => {
            const d = Math.hypot(pt.x - centerScreen.x, pt.y - centerScreen.y);
            return Math.max(max, d);
          }, 0);
          const gizmoRadius = Math.max(30, boundsRadius + 16);
          const scaleHandleScreen = {
            x: centerScreen.x + gizmoRadius,
            y: centerScreen.y,
          };
          const rotateHandleScreen = {
            x: centerScreen.x,
            y: centerScreen.y - gizmoRadius,
          };

          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(centerScreen.x, centerScreen.y);
          ctx.lineTo(scaleHandleScreen.x, scaleHandleScreen.y);
          ctx.moveTo(centerScreen.x, centerScreen.y);
          ctx.lineTo(rotateHandleScreen.x, rotateHandleScreen.y);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.beginPath();
          ctx.fillStyle = '#0f172a';
          ctx.arc(centerScreen.x, centerScreen.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = '#67e8f9';
          ctx.stroke();

          ctx.fillStyle = '#22d3ee';
          ctx.fillRect(scaleHandleScreen.x - 4, scaleHandleScreen.y - 4, 8, 8);
          ctx.strokeStyle = '#082f49';
          ctx.strokeRect(scaleHandleScreen.x - 4, scaleHandleScreen.y - 4, 8, 8);

          ctx.beginPath();
          ctx.fillStyle = '#f59e0b';
          ctx.arc(rotateHandleScreen.x, rotateHandleScreen.y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = '#1c1917';
          ctx.stroke();

          ctx.restore();

          maskOverlayRef.current = {
            clipId: controlledLayer.clip.id,
            maskId: activeMask.id,
            frame: controlledLayer.clipLocalFrame,
            points: points.map((p) => ({ ...p })),
            normalized,
            geometry,
            screenPoints,
            screenIn,
            screenOut,
            centerMask,
            centerScreen,
            scaleHandleScreen,
            rotateHandleScreen,
            gizmoRadius,
            closed: activeMask.closed,
          };
        }
      }
    }

    const renderElapsed = performance.now() - renderStartedAt;
    const perf = renderCostRef.current;
    const now = performance.now();
    if (Math.abs(perf.value - renderElapsed) >= 0.4 || now - perf.lastUpdateAt >= 450) {
      perf.value = renderElapsed;
      perf.lastUpdateAt = now;
      setRenderCostMs(Math.round(renderElapsed * 10) / 10);
    }

    lastPlayingRef.current = isPlaying;
  }, [
    activeLayers,
    activeMask,
    maskEditMode,
    maskOnionSkinEnabled,
    rendererMode,
    isPlaying,
    shuttleSpeed,
    getOrCreateVideo,
    getLayerGeometry,
    zoom,
    pan,
    renderTick,
    seqResolution.width,
    seqResolution.height,
    controlledLayer,
    getDisplayRect,
    selectedMaskPoint,
  ]);

  useEffect(() => {
    if (isPlaying) return;
    setRenderTick((v) => v + 1);
  }, [currentFrame, isPlaying]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const maskDrag = maskDragRef.current;
      if (maskDrag) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const p = clientToCanvasPoint(canvas, e.clientX, e.clientY);
        const mapped = mapCanvasToMaskPoint(
          p.x,
          p.y,
          maskDrag.geometry,
          maskDrag.normalized,
        );
        let nextPoints: MaskPoint[] = [];
        if (maskDrag.mode === 'point') {
          const dx = mapped.x - maskDrag.startMaskX;
          const dy = mapped.y - maskDrag.startMaskY;
          nextPoints = maskDrag.basePoints.map((pt, idx) => {
            if (idx !== maskDrag.pointIndex) return pt;
            return {
              x: maskDrag.startMaskX + dx,
              y: maskDrag.startMaskY + dy,
              inX: pt.inX + dx,
              inY: pt.inY + dy,
              outX: pt.outX + dx,
              outY: pt.outY + dy,
            };
          });
        } else if (maskDrag.mode === 'point-in-handle') {
          nextPoints = maskDrag.basePoints.map((pt, idx) => {
            if (idx !== maskDrag.pointIndex) return pt;
            return {
              ...pt,
              inX: mapped.x,
              inY: mapped.y,
            };
          });
        } else if (maskDrag.mode === 'point-out-handle') {
          nextPoints = maskDrag.basePoints.map((pt, idx) => {
            if (idx !== maskDrag.pointIndex) return pt;
            return {
              ...pt,
              outX: mapped.x,
              outY: mapped.y,
            };
          });
        } else if (maskDrag.mode === 'shape') {
          const dx = mapped.x - maskDrag.startMaskX;
          const dy = mapped.y - maskDrag.startMaskY;
          nextPoints = transformMaskPoints(maskDrag.basePoints, maskDrag.centerMaskX, maskDrag.centerMaskY, {
            translateX: dx,
            translateY: dy,
          });
        } else if (maskDrag.mode === 'shape-scale') {
          const currentDistance = Math.hypot(
            p.x - maskDrag.centerScreenX,
            p.y - maskDrag.centerScreenY,
          );
          const factor = currentDistance / Math.max(1, maskDrag.startScreenDistance);
          nextPoints = transformMaskPoints(maskDrag.basePoints, maskDrag.centerMaskX, maskDrag.centerMaskY, {
            scale: Math.max(0.05, Math.min(20, factor)),
          });
        } else {
          const currentAngle = Math.atan2(
            p.y - maskDrag.centerScreenY,
            p.x - maskDrag.centerScreenX,
          );
          const deltaAngle = currentAngle - maskDrag.startScreenAngle;
          nextPoints = transformMaskPoints(maskDrag.basePoints, maskDrag.centerMaskX, maskDrag.centerMaskY, {
            rotateRad: deltaAngle,
          });
        }
        maskDrag.points = nextPoints;
        maskPreviewRef.current = {
          clipId: maskDrag.clipId,
          maskId: maskDrag.maskId,
          frame: maskDrag.frame,
          points: nextPoints.map((pt) => ({ ...pt })),
        };
        setRenderTick((v) => v + 1);
        return;
      }

      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;

      if (drag.mode === 'move') {
        transformPreviewRef.current = {
          clipId: drag.clipId,
          positionX: drag.posX + dx / Math.max(0.01, zoom),
          positionY: drag.posY + dy / Math.max(0.01, zoom),
          scaleX: drag.scaleX,
          scaleY: drag.scaleY,
        };
      } else {
        const factor = Math.max(0.1, 1 + (dx + dy) / 300);
        transformPreviewRef.current = {
          clipId: drag.clipId,
          positionX: drag.posX,
          positionY: drag.posY,
          scaleX: safeScale(drag.scaleX * factor),
          scaleY: safeScale(drag.scaleY * factor),
        };
      }
      setRenderTick((v) => v + 1);
    };

    const onUp = () => {
      const maskDrag = maskDragRef.current;
      if (maskDrag) {
        void upsertMaskShapeKeyframe(maskDrag.clipId, maskDrag.maskId, {
          id: maskDrag.keyframeId,
          frame: maskDrag.frame,
          points: maskDrag.points.map((pt) => ({ ...pt })),
        });
        if (
          (maskDrag.mode === 'point' ||
            maskDrag.mode === 'point-in-handle' ||
            maskDrag.mode === 'point-out-handle') &&
          maskDrag.pointIndex >= 0
        ) {
          setSelectedMaskPoint({
            clipId: maskDrag.clipId,
            maskId: maskDrag.maskId,
            pointIndex: maskDrag.pointIndex,
          });
        }
        maskDragRef.current = null;
        maskPreviewRef.current = null;
        setRenderTick((v) => v + 1);
        return;
      }

      const drag = dragRef.current;
      const preview = transformPreviewRef.current;
      if (drag && preview && preview.clipId === drag.clipId) {
        void updateClipProperties(drag.clipId, {
          positionX: preview.positionX,
          positionY: preview.positionY,
          scaleX: preview.scaleX,
          scaleY: preview.scaleY,
        });

        if (autoKeyframeEnabled) {
          const clip = activeLayers.find((layer) => layer.clip.id === drag.clipId)?.clip ?? null;
          const localFrame = Math.max(0, Math.round(drag.clipLocalFrame));
          const existing = clip?.keyframes ?? [];
          const getExistingId = (property: TimelineKeyframeData['property']): string | null =>
            existing.find((kf) => kf.property === property && kf.frame === localFrame)?.id ?? null;
          const makeId = (property: TimelineKeyframeData['property']): string =>
            getExistingId(property) ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12);

          const maybeUpsert = (
            property: TimelineKeyframeData['property'],
            value: number,
            previous: number,
          ): void => {
            if (Math.abs(value - previous) < 0.0001) return;
            void upsertClipKeyframe(drag.clipId, {
              id: makeId(property),
              property,
              frame: localFrame,
              value,
              easing: 'linear',
            });
          };

          maybeUpsert(
            'transform.positionX',
            preview.positionX,
            drag.posX,
          );
          maybeUpsert(
            'transform.positionY',
            preview.positionY,
            drag.posY,
          );
          maybeUpsert(
            'transform.scaleX',
            preview.scaleX,
            drag.scaleX,
          );
          maybeUpsert(
            'transform.scaleY',
            preview.scaleY,
            drag.scaleY,
          );
        }
      }
      dragRef.current = null;
      transformPreviewRef.current = null;
      setRenderTick((v) => v + 1);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [
    activeLayers,
    autoKeyframeEnabled,
    upsertClipKeyframe,
    upsertMaskShapeKeyframe,
    updateClipProperties,
    zoom,
  ]);

  useEffect(() => {
    return () => {
      for (const video of videoByClipIdRef.current.values()) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      videoByClipIdRef.current.clear();
      seekStateRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!maskEditMode) return;
      if (e.defaultPrevented) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTypingTarget =
        tag === 'input' || tag === 'textarea' || target?.isContentEditable === true;
      if (isTypingTarget) return;

      if (e.key === '[' || e.key === ']') {
        if (!controlledLayer || !activeMask) return;
        const sorted = [...(activeMask.keyframes ?? [])].sort((a, b) => a.frame - b.frame);
        if (sorted.length === 0) return;
        const localFrame = controlledLayer.clipLocalFrame;
        const targetFrame =
          e.key === '['
            ? [...sorted].reverse().find((kf) => kf.frame < localFrame)?.frame ?? null
            : sorted.find((kf) => kf.frame > localFrame)?.frame ?? null;
        if (targetFrame != null) {
          setCurrentFrame(Math.max(0, Math.round(controlledLayer.clip.startFrame + targetFrame)));
          e.preventDefault();
        }
        return;
      }

      if (!selectedMaskPoint) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;

      const overlay = maskOverlayRef.current;
      if (!overlay) return;
      if (
        overlay.clipId !== selectedMaskPoint.clipId ||
        overlay.maskId !== selectedMaskPoint.maskId
      ) {
        return;
      }
      if (overlay.points.length <= 2) return;

      const idx = Math.max(0, Math.min(overlay.points.length - 1, selectedMaskPoint.pointIndex));
      void removeMaskPointAcrossKeyframes(overlay.clipId, overlay.maskId, idx);
      setSelectedMaskPoint({
        clipId: overlay.clipId,
        maskId: overlay.maskId,
        pointIndex: Math.max(0, Math.min(idx, overlay.points.length - 2)),
      });
      e.preventDefault();
      setRenderTick((v) => v + 1);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    maskEditMode,
    selectedMaskPoint,
    controlledLayer,
    activeMask,
    setCurrentFrame,
    removeMaskPointAcrossKeyframes,
  ]);

  const clientXToFrame = useCallback(
    (clientX: number): number => {
      const el = viewfinderRef.current;
      if (!el || totalFrames <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      return Math.round(pct * totalFrames);
    },
    [totalFrames],
  );

  const beginViewfinderDrag = useCallback(
    (mode: 'playhead' | 'in' | 'out', e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      vfDragModeRef.current = mode;
      const frame = clientXToFrame(e.clientX);
      if (mode === 'playhead') {
        setCurrentFrame(frame);
      } else if (mode === 'in') {
        setInPointAt(frame);
      } else {
        setOutPointAt(frame);
      }
    },
    [clientXToFrame, setCurrentFrame, setInPointAt, setOutPointAt],
  );

  const beginRangeDrag = useCallback(
    (e: React.MouseEvent) => {
      if (!e.shiftKey || inPoint == null || outPoint == null) return;
      e.preventDefault();
      e.stopPropagation();
      vfDragModeRef.current = 'range';
      const frame = clientXToFrame(e.clientX);
      vfRangeDragRef.current = {
        inFrame: inPoint,
        outFrame: outPoint,
        anchorOffset: frame - inPoint,
      };
    },
    [clientXToFrame, inPoint, outPoint],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const mode = vfDragModeRef.current;
      if (!mode) return;
      const frame = clientXToFrame(e.clientX);
      if (mode === 'playhead') {
        setCurrentFrame(frame);
      } else if (mode === 'in') {
        setInPointAt(frame);
      } else if (mode === 'out') {
        setOutPointAt(frame);
      } else {
        const rr = vfRangeDragRef.current;
        if (!rr) return;
        const span = rr.outFrame - rr.inFrame;
        const rawIn = frame - rr.anchorOffset;
        const nextIn = Math.max(0, Math.min(Math.max(0, totalFrames - span), rawIn));
        setInPointAt(nextIn);
        setOutPointAt(nextIn + span);
      }
    };

    const onUp = () => {
      vfDragModeRef.current = null;
      vfRangeDragRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [clientXToFrame, setCurrentFrame, setInPointAt, setOutPointAt, totalFrames]);

  const startTransformDrag = useCallback(
    (e: React.MouseEvent) => {
      if (!activeLayers.length || isPlaying) return;
      setActivePanel('program-monitor');

      if (maskEditMode) {
        const overlay = maskOverlayRef.current;
        const canvas = canvasRef.current;
        if (overlay && canvas) {
          const p = clientToCanvasPoint(canvas, e.clientX, e.clientY);
          const mapped = mapCanvasToMaskPoint(
            p.x,
            p.y,
            overlay.geometry,
            overlay.normalized,
          );
          const exactMask = controlledLayer?.clip.masks?.find((m) => m.id === overlay.maskId) ?? null;
          const existingKeyframeId =
            exactMask?.keyframes.find((kf) => kf.frame === overlay.frame)?.id ?? null;
          const keyframeId =
            existingKeyframeId ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12);
          const basePoints = overlay.points.map((pt) => ({ ...pt }));
          const handleThreshold = 10;
          let handleHit:
            | {
                mode: 'point-in-handle' | 'point-out-handle';
                pointIndex: number;
                startMaskX: number;
                startMaskY: number;
              }
            | null = null;
          let handleDist = Number.POSITIVE_INFINITY;
          for (let i = 0; i < overlay.screenPoints.length; i++) {
            const inSp = overlay.screenIn[i];
            const outSp = overlay.screenOut[i];
            const inD = Math.hypot(inSp.x - p.x, inSp.y - p.y);
            if (inD <= handleThreshold && inD < handleDist) {
              handleDist = inD;
              handleHit = {
                mode: 'point-in-handle',
                pointIndex: i,
                startMaskX: overlay.points[i]?.inX ?? 0,
                startMaskY: overlay.points[i]?.inY ?? 0,
              };
            }
            const outD = Math.hypot(outSp.x - p.x, outSp.y - p.y);
            if (outD <= handleThreshold && outD < handleDist) {
              handleDist = outD;
              handleHit = {
                mode: 'point-out-handle',
                pointIndex: i,
                startMaskX: overlay.points[i]?.outX ?? 0,
                startMaskY: overlay.points[i]?.outY ?? 0,
              };
            }
          }
          if (handleHit) {
            maskDragRef.current = {
              mode: handleHit.mode,
              clipId: overlay.clipId,
              maskId: overlay.maskId,
              keyframeId,
              frame: overlay.frame,
              pointIndex: handleHit.pointIndex,
              startMaskX: handleHit.startMaskX,
              startMaskY: handleHit.startMaskY,
              centerMaskX: overlay.centerMask.x,
              centerMaskY: overlay.centerMask.y,
              centerScreenX: overlay.centerScreen.x,
              centerScreenY: overlay.centerScreen.y,
              startScreenDistance: Math.max(
                1,
                Math.hypot(p.x - overlay.centerScreen.x, p.y - overlay.centerScreen.y),
              ),
              startScreenAngle: Math.atan2(
                p.y - overlay.centerScreen.y,
                p.x - overlay.centerScreen.x,
              ),
              basePoints: basePoints.map((pt) => ({ ...pt })),
              points: basePoints.map((pt) => ({ ...pt })),
              normalized: overlay.normalized,
              geometry: overlay.geometry,
            };
            setSelectedMaskPoint({
              clipId: overlay.clipId,
              maskId: overlay.maskId,
              pointIndex: handleHit.pointIndex,
            });
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          const scaleHandleDistance = Math.hypot(
            overlay.scaleHandleScreen.x - p.x,
            overlay.scaleHandleScreen.y - p.y,
          );
          if (scaleHandleDistance <= 10) {
            maskDragRef.current = {
              mode: 'shape-scale',
              clipId: overlay.clipId,
              maskId: overlay.maskId,
              keyframeId,
              frame: overlay.frame,
              pointIndex: -1,
              startMaskX: mapped.x,
              startMaskY: mapped.y,
              centerMaskX: overlay.centerMask.x,
              centerMaskY: overlay.centerMask.y,
              centerScreenX: overlay.centerScreen.x,
              centerScreenY: overlay.centerScreen.y,
              startScreenDistance: Math.max(
                1,
                Math.hypot(p.x - overlay.centerScreen.x, p.y - overlay.centerScreen.y),
              ),
              startScreenAngle: Math.atan2(
                p.y - overlay.centerScreen.y,
                p.x - overlay.centerScreen.x,
              ),
              basePoints: basePoints.map((pt) => ({ ...pt })),
              points: basePoints.map((pt) => ({ ...pt })),
              normalized: overlay.normalized,
              geometry: overlay.geometry,
            };
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          const rotateHandleDistance = Math.hypot(
            overlay.rotateHandleScreen.x - p.x,
            overlay.rotateHandleScreen.y - p.y,
          );
          if (rotateHandleDistance <= 10) {
            maskDragRef.current = {
              mode: 'shape-rotate',
              clipId: overlay.clipId,
              maskId: overlay.maskId,
              keyframeId,
              frame: overlay.frame,
              pointIndex: -1,
              startMaskX: mapped.x,
              startMaskY: mapped.y,
              centerMaskX: overlay.centerMask.x,
              centerMaskY: overlay.centerMask.y,
              centerScreenX: overlay.centerScreen.x,
              centerScreenY: overlay.centerScreen.y,
              startScreenDistance: Math.max(
                1,
                Math.hypot(p.x - overlay.centerScreen.x, p.y - overlay.centerScreen.y),
              ),
              startScreenAngle: Math.atan2(
                p.y - overlay.centerScreen.y,
                p.x - overlay.centerScreen.x,
              ),
              basePoints: basePoints.map((pt) => ({ ...pt })),
              points: basePoints.map((pt) => ({ ...pt })),
              normalized: overlay.normalized,
              geometry: overlay.geometry,
            };
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          const pointThreshold = 12;
          let hitPointIdx = -1;
          let hitDist = Number.POSITIVE_INFINITY;
          for (let i = 0; i < overlay.screenPoints.length; i++) {
            const sp = overlay.screenPoints[i];
            const d = Math.hypot(sp.x - p.x, sp.y - p.y);
            if (d < pointThreshold && d < hitDist) {
              hitDist = d;
              hitPointIdx = i;
            }
          }

          if (hitPointIdx >= 0) {
            const hitPoint = overlay.points[hitPointIdx];
            maskDragRef.current = {
              mode: 'point',
              clipId: overlay.clipId,
              maskId: overlay.maskId,
              keyframeId,
              frame: overlay.frame,
              pointIndex: hitPointIdx,
              startMaskX: hitPoint?.x ?? 0,
              startMaskY: hitPoint?.y ?? 0,
              centerMaskX: overlay.centerMask.x,
              centerMaskY: overlay.centerMask.y,
              centerScreenX: overlay.centerScreen.x,
              centerScreenY: overlay.centerScreen.y,
              startScreenDistance: Math.max(
                1,
                Math.hypot(p.x - overlay.centerScreen.x, p.y - overlay.centerScreen.y),
              ),
              startScreenAngle: Math.atan2(
                p.y - overlay.centerScreen.y,
                p.x - overlay.centerScreen.x,
              ),
              basePoints: basePoints.map((pt) => ({ ...pt })),
              points: basePoints.map((pt) => ({ ...pt })),
              normalized: overlay.normalized,
              geometry: overlay.geometry,
            };
            setSelectedMaskPoint({
              clipId: overlay.clipId,
              maskId: overlay.maskId,
              pointIndex: hitPointIdx,
            });
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if (e.shiftKey && overlay.points.length >= 2) {
            let bestSegIndex = 0;
            let bestSegDist = Number.POSITIVE_INFINITY;
            const maxSeg = overlay.closed ? overlay.points.length : overlay.points.length - 1;
            for (let i = 0; i < maxSeg; i++) {
              const a = overlay.screenPoints[i];
              const b = overlay.screenPoints[(i + 1) % overlay.screenPoints.length];
              const d = distancePointToSegment(p.x, p.y, a.x, a.y, b.x, b.y);
              if (d < bestSegDist) {
                bestSegDist = d;
                bestSegIndex = i;
              }
            }

            const insertAt = bestSegIndex + 1;
            void insertMaskPointAcrossKeyframes(overlay.clipId, overlay.maskId, {
              frame: overlay.frame,
              insertAt,
              point: {
                x: mapped.x,
                y: mapped.y,
                inX: mapped.x,
                inY: mapped.y,
                outX: mapped.x,
                outY: mapped.y,
              },
            });
            setSelectedMaskPoint({
              clipId: overlay.clipId,
              maskId: overlay.maskId,
              pointIndex: insertAt,
            });
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if (overlay.closed && pointInPolygon(p.x, p.y, overlay.screenPoints)) {
            maskDragRef.current = {
              mode: 'shape',
              clipId: overlay.clipId,
              maskId: overlay.maskId,
              keyframeId,
              frame: overlay.frame,
              pointIndex: -1,
              startMaskX: mapped.x,
              startMaskY: mapped.y,
              centerMaskX: overlay.centerMask.x,
              centerMaskY: overlay.centerMask.y,
              centerScreenX: overlay.centerScreen.x,
              centerScreenY: overlay.centerScreen.y,
              startScreenDistance: Math.max(
                1,
                Math.hypot(p.x - overlay.centerScreen.x, p.y - overlay.centerScreen.y),
              ),
              startScreenAngle: Math.atan2(
                p.y - overlay.centerScreen.y,
                p.x - overlay.centerScreen.x,
              ),
              basePoints: basePoints.map((pt) => ({ ...pt })),
              points: basePoints.map((pt) => ({ ...pt })),
              normalized: overlay.normalized,
              geometry: overlay.geometry,
            };
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
      }

      const x = e.nativeEvent.offsetX;
      const y = e.nativeEvent.offsetY;
      const hs = 12;

      const pointIn = (r: Rect) =>
        x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
      const inScaleHandle = (r: Rect) => x >= r.x + r.width - hs && y >= r.y + r.height - hs;

      const pickByHit = () => {
        for (let i = activeLayers.length - 1; i >= 0; i--) {
          const layer = activeLayers[i];
          const rect = getDisplayRect(layer);
          if (!rect) continue;
          if (pointIn(rect)) return { layer, rect };
        }
        return null;
      };

      const target = pickByHit();
      if (!target) return;

      const mode: 'move' | 'scale' = inScaleHandle(target.rect) ? 'scale' : 'move';

      if (selectionArray.length !== 1 || selectionArray[0] !== target.layer.clip.id) {
        selectClip(target.layer.clip.id);
      }

      dragRef.current = {
        mode,
        clipId: target.layer.clip.id,
        clipLocalFrame: target.layer.clipLocalFrame,
        startX: e.clientX,
        startY: e.clientY,
        posX: target.layer.clip.positionX ?? 0,
        posY: target.layer.clip.positionY ?? 0,
        scaleX: target.layer.clip.scaleX ?? 1,
        scaleY: target.layer.clip.scaleY ?? 1,
      };
      e.preventDefault();
      e.stopPropagation();
    },
    [
      activeLayers,
      isPlaying,
      setActivePanel,
      maskEditMode,
      controlledLayer?.clip.masks,
      getDisplayRect,
      selectionArray,
      selectClip,
      insertMaskPointAcrossKeyframes,
    ],
  );

  const addMaskToControlledClip = useCallback(() => {
    if (!controlledLayer) return;
    const geometry = getLayerGeometry(controlledLayer);
    const srcW = geometry?.sourceWidth ?? seqResolution.width;
    const srcH = geometry?.sourceHeight ?? seqResolution.height;
    const maskId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const keyframeId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const existingCount = controlledLayer.clip.masks?.length ?? 0;
    void addClipMask(controlledLayer.clip.id, {
      id: maskId,
      name: `Mask ${existingCount + 1}`,
      mode: 'add',
      closed: true,
      invert: false,
      opacity: 1,
      feather: 0,
      expansion: 0,
      keyframes: [
        {
          id: keyframeId,
          frame: controlledLayer.clipLocalFrame,
          points: createDefaultMaskPoints(srcW, srcH),
        },
      ],
    });
    setMaskEditMode(true);
    setActiveMaskId(maskId);
    setSelectedMaskPoint({
      clipId: controlledLayer.clip.id,
      maskId,
      pointIndex: 0,
    });
  }, [
    controlledLayer,
    getLayerGeometry,
    seqResolution.width,
    seqResolution.height,
    addClipMask,
    createDefaultMaskPoints,
  ]);

  const cycleRendererMode = useCallback(() => {
    if (rendererMode === 'auto') {
      setRendererMode('webgl2');
      return;
    }
    if (rendererMode === 'webgl2') {
      setRendererMode('canvas2d');
      return;
    }
    setRendererMode('auto');
  }, [rendererMode, setRendererMode]);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Program
        </span>
        <span className="font-mono text-xs text-zinc-400">{formatTimecode(currentFrame, fps)}</span>
      </div>

      <div ref={containerRef} className="relative flex flex-1 items-center justify-center bg-black">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          onMouseDown={startTransformDrag}
        />

        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-2 text-[10px]">
          <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-zinc-300">
            {formatTimecode(currentFrame, fps)}
          </span>
          <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-zinc-400">
            clip: {controlledLayer?.clip.id ?? '-'}
          </span>
          <span
            className={`rounded bg-black/60 px-1.5 py-0.5 font-mono ${
              renderCostMs > 20 ? 'text-amber-300' : 'text-zinc-400'
            }`}
            title="Approximate frame render time"
          >
            {renderCostMs.toFixed(1)}ms
          </span>
        </div>

        <div className="absolute right-2 top-2 flex items-center gap-1">
          <TBtn
            label={autoKeyframeEnabled ? 'AutoKey On' : 'AutoKey'}
            title="Toggle automatic keyframe creation while dragging transform controls"
            className={autoKeyframeEnabled ? 'bg-emerald-700/80 text-white' : ''}
            onClick={() => setAutoKeyframeEnabled(!autoKeyframeEnabled)}
          />
          <TBtn
            label={
              rendererMode === 'auto'
                ? 'Renderer Auto'
                : rendererMode === 'webgl2'
                  ? 'Renderer GL2'
                  : 'Renderer 2D'
            }
            title={`Cycle renderer mode (Auto -> WebGL2 -> Canvas2D). Active backend: ${
              rendererStatus.backend === 'webgl2' ? 'WebGL2' : 'Canvas2D'
            }${rendererStatus.reason ? ` | ${rendererStatus.reason}` : ''}`}
            className={
              rendererStatus.backend === 'webgl2'
                ? 'bg-blue-700/70 text-white'
                : rendererStatus.reason
                  ? 'bg-amber-700/70 text-white'
                  : ''
            }
            onClick={cycleRendererMode}
          />
          <span
            className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
            title={rendererStatus.reason ?? 'Active renderer backend'}
          >
            {rendererStatus.backend === 'webgl2' ? 'GL2' : '2D'}
          </span>
          <TBtn
            label={maskEditMode ? 'Mask On' : 'Mask'}
            title="Toggle mask point editing mode"
            className={maskEditMode ? 'bg-cyan-700/80 text-white' : ''}
            onClick={() => {
              setMaskEditMode((v) => !v);
              maskDragRef.current = null;
              maskPreviewRef.current = null;
            }}
          />
          <TBtn
            label={maskOnionSkinEnabled ? 'Onion On' : 'Onion'}
            title="Toggle onion skin for previous/next mask keyframes"
            className={maskOnionSkinEnabled ? 'bg-sky-700/70 text-white' : ''}
            onClick={() => setMaskOnionSkinEnabled((v) => !v)}
          />
          <TBtn
            label="+Mask"
            title="Add mask to selected clip"
            disabled={!controlledLayer}
            onClick={() => addMaskToControlledClip()}
          />
          <TBtn
            label="-"
            title="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}
          />
          <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
            {Math.round(zoom * 100)}%
          </span>
          <TBtn label="+" title="Zoom in" onClick={() => setZoom((z) => Math.min(4, z * 1.25))} />
          <TBtn
            label="Fit"
            title="Fit view"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          />
        </div>

        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-0.5">
          <TBtn label="|<" title="Go to start" onClick={goToStart} />
          <TBtn label="<" title="Step back" onClick={stepBackward} />
          <TBtn
            label={isPlaying ? 'Pause' : 'Play'}
            title="Play / Pause (Space)"
            className="bg-zinc-700 px-3"
            onClick={togglePlayPause}
          />
          <TBtn label=">" title="Step forward" onClick={stepForward} />
          <TBtn label=">|" title="Go to end" onClick={goToEnd} />
          <TBtn label="I" title="Set In" onClick={() => setInPointAt(currentFrame)} />
          <TBtn label="O" title="Set Out" onClick={() => setOutPointAt(currentFrame)} />
          <TBtn label="Clr" title="Clear In/Out" onClick={clearInOutPoints} />
          <TBtn
            label="Lift"
            title="Lift by In/Out"
            onClick={(e) => {
              if (!hasValidInOut) return;
              void liftRangeByInOut(inPoint!, outPoint!, {
                selectedClipIds: selectionArray,
                targetTrackIds: [targetVideoTrackId, targetAudioTrackId].filter(
                  Boolean,
                ) as string[],
                includeLinked: e.altKey ? !linkedSelection : linkedSelection,
                useSyncLock: true,
              });
            }}
            disabled={!hasValidInOut}
          />
          <TBtn
            label="Extract"
            title="Extract by In/Out"
            onClick={(e) => {
              if (!hasValidInOut) return;
              void extractRangeByInOut(inPoint!, outPoint!, {
                selectedClipIds: selectionArray,
                targetTrackIds: [targetVideoTrackId, targetAudioTrackId].filter(
                  Boolean,
                ) as string[],
                includeLinked: e.altKey ? !linkedSelection : linkedSelection,
                useSyncLock: true,
              });
            }}
            disabled={!hasValidInOut}
          />
        </div>
      </div>

      <div className="border-t border-zinc-700 bg-zinc-900/70 px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-500">
          <span>Viewfinder</span>
          <span>{formatTimecode(currentFrame, fps)}</span>
        </div>
        <div
          ref={viewfinderRef}
          className="relative h-7 select-none rounded border border-zinc-700 bg-zinc-800"
          onMouseDown={(e) => beginViewfinderDrag('playhead', e)}
        >
          {totalFrames > 0 && inPoint != null && outPoint != null && outPoint > inPoint && (
            <div
              className="absolute top-0 bottom-0 rounded bg-cyan-500/30 ring-1 ring-cyan-400/60"
              style={{
                left: `${(inPoint / totalFrames) * 100}%`,
                width: `${((outPoint - inPoint) / totalFrames) * 100}%`,
              }}
              onMouseDown={beginRangeDrag}
              title="Shift+Drag to move In/Out range"
            />
          )}

          {totalFrames > 0 && inPoint != null && (
            <button
              className="absolute top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize bg-cyan-300/90"
              style={{ left: `${(inPoint / totalFrames) * 100}%` }}
              onMouseDown={(e) => beginViewfinderDrag('in', e)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setInPointAt(0);
              }}
              title="Drag In point"
            />
          )}

          {totalFrames > 0 && outPoint != null && (
            <button
              className="absolute top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize bg-cyan-300/90"
              style={{ left: `${(outPoint / totalFrames) * 100}%` }}
              onMouseDown={(e) => beginViewfinderDrag('out', e)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOutPointAt(totalFrames);
              }}
              title="Drag Out point"
            />
          )}

          {totalFrames > 0 && (
            <div
              className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-blue-400"
              style={{ left: `${(currentFrame / totalFrames) * 100}%` }}
            />
          )}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <input
            value={timeInput}
            onChange={(e) => setTimeInput(e.target.value)}
            onBlur={() => {
              const f = parseTimecodeToFrame(timeInput, fps);
              if (f != null) setCurrentFrame(f);
              setTimeInput(formatTimecode(usePlaybackStore.getState().currentFrame, fps));
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const f = parseTimecodeToFrame(timeInput, fps);
              if (f != null) setCurrentFrame(f);
            }}
            className="w-32 rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-200"
          />
          <span className="text-[10px] text-zinc-500">
            {maskEditMode
              ? 'Mask mode: drag points or Bezier handles, drag inside closed mask to move shape, drag cyan square/orange circle for scale/rotate, Shift+Click edge to add, Delete to remove, [ / ] jumps prev/next mask keyframe, Onion shows prev/next'
              : 'Drag clip in viewer to move, corner to resize'}
          </span>
        </div>
      </div>
    </div>
  );
}

function TBtn({
  label,
  title,
  className = '',
  onClick,
  disabled,
}: {
  label: string;
  title: string;
  className?: string;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {label}
    </button>
  );
}
