import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSelectionStore } from '../stores/selectionStore.js';
import { useProjectStore, computeTransitionSideLimit } from '../stores/projectStore.js';
import { applySegmentKeyframeEasing } from '../lib/keyframeEasing.js';
import type {
  TimelineClipData,
  TimelineTrackData,
  ManualMaskData,
  MaskPoint,
  MaskShapeKeyframe,
} from '../stores/projectStore.js';
import { usePlaybackStore } from '../stores/playbackStore.js';

function formatFrames(frames: number, fps: number = 30): string {
  const totalSec = frames / fps;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const f = frames % fps;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s
    .toString()
    .padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function clampScale(v: number): number {
  if (Math.abs(v) < 0.01) return v < 0 ? -0.01 : 0.01;
  return v;
}

function gainToDb(gain: number): number {
  if (gain <= 0.000001) return -60;
  return Math.max(-60, Math.min(12, 20 * Math.log10(gain)));
}

function dbToGain(db: number): number {
  if (db <= -59.5) return 0;
  return Math.pow(10, db / 20);
}

const EQ_BANDS: Array<{ key: keyof TimelineClipData; label: string }> = [
  { key: 'audioEq63', label: '63' },
  { key: 'audioEq125', label: '125' },
  { key: 'audioEq250', label: '250' },
  { key: 'audioEq500', label: '500' },
  { key: 'audioEq1k', label: '1k' },
  { key: 'audioEq2k', label: '2k' },
  { key: 'audioEq4k', label: '4k' },
  { key: 'audioEq8k', label: '8k' },
];

const MASK_CHIP_COLORS = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#fb7185', '#facc15', '#60a5fa'];

export const KEYFRAME_PROPERTIES: Array<{
  value: NonNullable<TimelineClipData['keyframes']>[number]['property'];
  label: string;
}> = [
  { value: 'speed', label: 'Speed' },
  { value: 'volume', label: 'Volume' },
  { value: 'pan', label: 'Pan' },
  { value: 'brightness', label: 'Brightness' },
  { value: 'contrast', label: 'Contrast' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'hue', label: 'Hue' },
  { value: 'vignette', label: 'Vignette' },
  { value: 'transform.positionX', label: 'Position X' },
  { value: 'transform.positionY', label: 'Position Y' },
  { value: 'transform.scaleX', label: 'Scale X' },
  { value: 'transform.scaleY', label: 'Scale Y' },
  { value: 'transform.rotation', label: 'Rotation' },
  { value: 'transform.anchorX', label: 'Anchor X' },
  { value: 'transform.anchorY', label: 'Anchor Y' },
  { value: 'opacity', label: 'Opacity' },
  { value: 'mask.opacity', label: 'Mask Opacity' },
  { value: 'mask.feather', label: 'Mask Feather' },
  { value: 'mask.expansion', label: 'Mask Expansion' },
];

export type KeyframeProperty = NonNullable<TimelineClipData['keyframes']>[number]['property'];

export interface KeyframeGraphSelectOptions {
  additive?: boolean;
  range?: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface SliderRailControls {
  left?: ReactNode;
  right?: ReactNode;
}

export function GlyphFrame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" aria-hidden="true">
      {children}
    </svg>
  );
}

export function ClockGlyph() {
  return (
    <GlyphFrame>
      <circle cx="8" cy="8" r="5.25" strokeWidth="1.5" />
      <path d="M8 5.25v3.1l2.3 1.35" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </GlyphFrame>
  );
}

export function PrevGlyph() {
  return (
    <GlyphFrame>
      <path d="M11 3.5 5.75 8 11 12.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.25 4v8" strokeWidth="1.8" strokeLinecap="round" />
    </GlyphFrame>
  );
}

export function NextGlyph() {
  return (
    <GlyphFrame>
      <path d="M5 3.5 10.25 8 5 12.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.75 4v8" strokeWidth="1.8" strokeLinecap="round" />
    </GlyphFrame>
  );
}

export function AddKeyGlyph() {
  return (
    <GlyphFrame>
      <path d="m8 2.5 4.5 5.5L8 13.5 3.5 8 8 2.5Z" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 5.25v5.5M5.25 8h5.5" strokeWidth="1.4" strokeLinecap="round" />
    </GlyphFrame>
  );
}

export function TrashGlyph() {
  return (
    <GlyphFrame>
      <path d="M5.25 4.5h5.5" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.25 4.5V3.4h3.5v1.1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.75 4.5v7.1c0 .5.4.9.9.9h4.7c.5 0 .9-.4.9-.9V4.5" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6.75 6.4v4.2M9.25 6.4v4.2" strokeWidth="1.4" strokeLinecap="round" />
    </GlyphFrame>
  );
}

export function IconActionButton({
  title,
  onClick,
  disabled = false,
  active = false,
  destructive = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`flex h-6 w-6 items-center justify-center rounded border text-[10px] transition-colors disabled:opacity-35 ${
        destructive
          ? 'border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20'
          : active
            ? 'border-amber-400/40 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
            : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
      }`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function defaultBezierHandles(): { inX: number; inY: number; outX: number; outY: number } {
  return {
    outX: 0.25,
    outY: 0.1,
    inX: 0.75,
    inY: 0.9,
  };
}

function keyframeValueBounds(property: KeyframeProperty, values: number[]): { min: number; max: number } {
  let min = -1;
  let max = 1;
  switch (property) {
    case 'speed':
      min = -4;
      max = 4;
      break;
    case 'volume':
      min = 0;
      max = 2;
      break;
    case 'pan':
      min = -1;
      max = 1;
      break;
    case 'brightness':
    case 'contrast':
    case 'saturation':
      min = 0;
      max = 2;
      break;
    case 'hue':
      min = -180;
      max = 180;
      break;
    case 'vignette':
      min = -1;
      max = 1;
      break;
    case 'transform.positionX':
    case 'transform.positionY':
      min = -3000;
      max = 3000;
      break;
    case 'transform.scaleX':
    case 'transform.scaleY':
      min = -4;
      max = 4;
      break;
    case 'transform.rotation':
      min = -180;
      max = 180;
      break;
    case 'transform.anchorX':
    case 'transform.anchorY':
      min = 0;
      max = 1;
      break;
    case 'opacity':
    case 'mask.opacity':
      min = 0;
      max = 1;
      break;
    case 'mask.feather':
      min = 0;
      max = 400;
      break;
    case 'mask.expansion':
      min = -400;
      max = 400;
      break;
    default:
      break;
  }

  if (values.length) {
    const realMin = Math.min(...values);
    const realMax = Math.max(...values);
    const span = Math.max(1e-4, realMax - realMin);
    const pad = span * 0.1;
    min = Math.min(min, realMin - pad);
    max = Math.max(max, realMax + pad);
  }

  if (Math.abs(max - min) < 1e-4) {
    max = min + 1;
  }
  return { min, max };
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-zinc-500">{label}</span>
      <span className="font-mono text-zinc-300">{value}</span>
    </div>
  );
}

function StaticSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-zinc-700 px-3 py-2">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-zinc-700">
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        onClick={onToggle}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {title}
        </span>
        <span className="text-xs text-zinc-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="space-y-2 px-3 pb-3">{children}</div>}
    </section>
  );
}

function SliderNumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  sliderControls,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  sliderControls?: SliderRailControls;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const safeValue = Math.max(min, Math.min(max, value));

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-zinc-500">{label}</span>
        <input
          type="number"
          value={text}
          step={step}
          min={min}
          max={max}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setText(String(value))}
          onBlur={() => {
            let n = Number(text);
            if (!Number.isFinite(n)) {
              setText(String(value));
              return;
            }
            n = Math.max(min, Math.min(max, n));
            onChange(n);
            setText(String(n));
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            let n = Number(text);
            if (!Number.isFinite(n)) return;
            n = Math.max(min, Math.min(max, n));
            onChange(n);
            setText(String(n));
          }}
          className="w-20 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-right font-mono text-[11px] text-zinc-200"
          title={format ? format(safeValue) : String(safeValue)}
        />
      </div>
      <div className="flex items-center gap-1.5">
        {sliderControls?.left && <div className="flex flex-none items-center gap-1">{sliderControls.left}</div>}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={safeValue}
          onChange={(e) => {
            const next = Number(e.target.value);
            onChange(next);
            setText(String(next));
          }}
          className="min-w-0 flex-1 accent-blue-500"
        />
        {sliderControls?.right && <div className="flex flex-none items-center gap-1">{sliderControls.right}</div>}
      </div>
      {format && <div className="text-[10px] text-zinc-500">{format(safeValue)}</div>}
    </div>
  );
}

function EqGraphic({
  values,
  onChange,
}: {
  values: Record<string, number>;
  onChange: (key: keyof TimelineClipData, value: number) => void;
}) {
  return (
    <div className="rounded border border-zinc-700 bg-zinc-900/60 p-2">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">Equalizer</div>
      <div className="grid grid-cols-8 gap-1">
        {EQ_BANDS.map((band) => {
          const value = values[band.key as string] ?? 0;
          return (
            <div key={band.label} className="flex flex-col items-center gap-1">
              <input
                type="range"
                min={-24}
                max={24}
                step={0.5}
                value={value}
                onChange={(e) => onChange(band.key, Number(e.target.value))}
                style={{
                  WebkitAppearance: 'slider-vertical',
                  width: '14px',
                  height: '88px',
                }}
                className="accent-blue-500"
              />
              <span className="text-[10px] text-zinc-400">{band.label}</span>
              <span className="font-mono text-[9px] text-zinc-500">{value.toFixed(0)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function KeyframeMiniGraph({
  keyframes,
  clipDuration,
  property,
  currentFrame,
  snapStep,
  selectedKeyframeId = null,
  selectedKeyframeIds = [],
  onCommit,
  onSelectKeyframe,
  onSetSelection,
  onToggleKeyframeCurve,
}: {
  keyframes: NonNullable<TimelineClipData['keyframes']>;
  clipDuration: number;
  property: KeyframeProperty;
  currentFrame: number;
  snapStep: number;
  selectedKeyframeId?: string | null;
  selectedKeyframeIds?: string[];
  onCommit: (
    keyframeId: string,
    patch: Partial<
      Pick<
        NonNullable<TimelineClipData['keyframes']>[number],
        'frame' | 'value' | 'bezierHandles'
      >
    >,
  ) => void;
  onSelectKeyframe?: (keyframeId: string, options?: KeyframeGraphSelectOptions) => void;
  onSetSelection?: (
    ids: string[],
    primaryId?: string | null,
    options?: { additive?: boolean },
  ) => void;
  onToggleKeyframeCurve?: (keyframeId: string) => void;
}) {
  const clipPathId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 960, height: 480 });
  const [draftById, setDraftById] = useState<
    Record<
      string,
      {
        frame: number;
        value: number;
        bezierHandles?: { inX: number; inY: number; outX: number; outY: number };
      }
    >
  >({});
  const [draggingPoint, setDraggingPoint] = useState<{
    keyframeId: string;
    minFrame: number;
    maxFrame: number;
  } | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<{ keyframeId: string; handle: 'in' | 'out' } | null>(
    null,
  );
  const [panning, setPanning] = useState<{ anchorClientX: number; startFrame: number; endFrame: number } | null>(
    null,
  );
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    additive: boolean;
  } | null>(null);
  const [viewStartFrame, setViewStartFrame] = useState(0);
  const [viewEndFrame, setViewEndFrame] = useState(Math.max(1, clipDuration));

  const safeSnapStep = Math.max(1, Math.round(snapStep));
  const totalDuration = Math.max(1, clipDuration);
  const minimumFrameWindowSpan = Math.max(2, safeSnapStep);

  useEffect(() => {
    setDraftById({});
  }, [property]);

  useEffect(() => {
    setViewStartFrame(0);
    setViewEndFrame(totalDuration);
  }, [totalDuration, property]);

  const sorted = useMemo(() => [...keyframes].sort((a, b) => a.frame - b.frame), [keyframes]);
  const effective = useMemo(
    () =>
      [...sorted.map((kf) => {
        const draft = draftById[kf.id];
        if (!draft) return kf;
        return {
          ...kf,
          frame: draft.frame,
          value: draft.value,
          bezierHandles: draft.bezierHandles ?? kf.bezierHandles,
        };
      })].sort((a, b) => a.frame - b.frame),
    [sorted, draftById],
  );
  const selectedIdsSet = useMemo(() => {
    const next = new Set(selectedKeyframeIds);
    if (selectedKeyframeId) next.add(selectedKeyframeId);
    return next;
  }, [selectedKeyframeId, selectedKeyframeIds]);

  if (!effective.length) {
    return <div className="text-[10px] text-zinc-500">No keyframes</div>;
  }

  const bounds = keyframeValueBounds(
    property,
    sorted.map((k) => k.value),
  );
  const span = Math.max(0.0001, bounds.max - bounds.min);
  const frameWindowStart = Math.max(0, Math.min(totalDuration, viewStartFrame));
  const frameWindowEnd = Math.max(
    frameWindowStart + 1,
    Math.min(totalDuration, viewEndFrame),
  );
  const frameWindowSpan = Math.max(1, frameWindowEnd - frameWindowStart);
  const graphWidth = Math.max(640, Math.round(viewportSize.width || 960));
  const graphHeight = Math.max(360, Math.round(viewportSize.height || 480));
  const graphPadding = {
    left: 64,
    right: 20,
    top: 18,
    bottom: 30,
  };
  const plotWidth = Math.max(1, graphWidth - graphPadding.left - graphPadding.right);
  const plotHeight = Math.max(1, graphHeight - graphPadding.top - graphPadding.bottom);
  const isFrameVisible = useCallback(
    (frame: number) => frame >= frameWindowStart && frame <= frameWindowEnd,
    [frameWindowEnd, frameWindowStart],
  );
  const toX = (frame: number): number =>
    graphPadding.left +
    ((frame - frameWindowStart) / frameWindowSpan) * plotWidth;
  const toY = (value: number): number =>
    graphPadding.top + (1 - (value - bounds.min) / span) * plotHeight;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const updateSize = () => {
      const rect = svg.getBoundingClientRect();
      const nextWidth = Math.max(640, Math.round(rect.width));
      const nextHeight = Math.max(360, Math.round(rect.height));
      setViewportSize((prev) =>
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight },
      );
    };

    updateSize();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }

    const observer = new ResizeObserver(() => updateSize());
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const curvePath = useMemo(() => {
    if (effective.length === 0) return '';
    if (effective.length === 1) {
      const x = toX(effective[0].frame);
      const y = toY(effective[0].value);
      return `M ${x.toFixed(3)} ${y.toFixed(3)}`;
    }

    let d = '';
    for (let i = 0; i < effective.length - 1; i++) {
      const from = effective[i];
      const to = effective[i + 1];
      const x0 = toX(from.frame);
        const y0 = toY(from.value);
        if (i === 0) d += `M ${x0.toFixed(3)} ${y0.toFixed(3)}`;

      const segmentFrames = Math.max(1, to.frame - from.frame);
      const steps = Math.max(8, Math.min(56, Math.round((segmentFrames / frameWindowSpan) * 160)));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const eased = applySegmentKeyframeEasing(
          t,
          from.easing,
          from.bezierHandles,
          to.easing,
          to.bezierHandles,
        );
        const frame = from.frame + segmentFrames * t;
        const value = from.value + (to.value - from.value) * eased;
        d += ` L ${toX(frame).toFixed(3)} ${toY(value).toFixed(3)}`;
      }
    }
    return d;
  }, [effective, frameWindowSpan, toX, toY]);
  const currentX = toX(currentFrame);

  const verticalTicks = useMemo(() => {
    const targetCount = 8;
    const rawStep = Math.max(1, frameWindowSpan / targetCount);
    const niceSteps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    const step = niceSteps.find((candidate) => candidate >= rawStep) ?? Math.ceil(rawStep);
    const start = Math.ceil(frameWindowStart / step) * step;
    const ticks: number[] = [];
    for (let frame = start; frame < frameWindowEnd; frame += step) {
      ticks.push(frame);
    }
    return ticks;
  }, [frameWindowEnd, frameWindowSpan, frameWindowStart]);

  const horizontalTicks = useMemo(
    () =>
      Array.from({ length: 5 }, (_, index) => {
        const ratio = index / 4;
        return bounds.max - ratio * (bounds.max - bounds.min);
      }),
    [bounds.max, bounds.min],
  );

  const fitFrameWindow = useCallback(() => {
    setViewStartFrame(0);
    setViewEndFrame(totalDuration);
  }, [totalDuration]);

  const applyFrameWindow = useCallback(
    (nextStart: number, nextEnd: number) => {
      if (totalDuration <= minimumFrameWindowSpan) {
        setViewStartFrame(0);
        setViewEndFrame(totalDuration);
        return;
      }

      let start = Number.isFinite(nextStart) ? nextStart : 0;
      let end = Number.isFinite(nextEnd) ? nextEnd : totalDuration;
      let span = Math.max(minimumFrameWindowSpan, end - start);

      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end > totalDuration) {
        const over = end - totalDuration;
        start = Math.max(0, start - over);
        end = totalDuration;
      }

      span = Math.max(minimumFrameWindowSpan, end - start);
      if (span > totalDuration) {
        start = 0;
        end = totalDuration;
      } else if (end - start < minimumFrameWindowSpan) {
        end = Math.min(totalDuration, start + minimumFrameWindowSpan);
        start = Math.max(0, end - minimumFrameWindowSpan);
      }

      setViewStartFrame(start);
      setViewEndFrame(end);
    },
    [minimumFrameWindowSpan, totalDuration],
  );

  const clientToGraphPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / Math.max(1, rect.width)) * graphWidth,
      y: ((clientY - rect.top) / Math.max(1, rect.height)) * graphHeight,
    };
  }, [graphHeight, graphWidth]);

  const updateFromPointer = useCallback(
    (
      keyframeId: string,
      clientX: number,
      clientY: number,
      dragBounds?: { minFrame: number; maxFrame: number },
    ) => {
      const point = clientToGraphPoint(clientX, clientY);
      if (!point) return;
      const nx = clamp01((point.x - graphPadding.left) / plotWidth);
      const ny = clamp01((point.y - graphPadding.top) / plotHeight);
      const rawFrame = frameWindowStart + nx * frameWindowSpan;
      const index = effective.findIndex((kf) => kf.id === keyframeId);
      const minFrame =
        dragBounds?.minFrame ??
        (index > 0 ? effective[index - 1]!.frame + safeSnapStep : 0);
      const maxFrame =
        dragBounds?.maxFrame ??
        (index >= 0 && index < effective.length - 1
          ? effective[index + 1]!.frame - safeSnapStep
          : totalDuration);
      const constrainedFrame = Math.max(minFrame, Math.min(maxFrame, rawFrame));
      const frame = Math.max(
        0,
        Math.min(totalDuration, Math.round(constrainedFrame / safeSnapStep) * safeSnapStep),
      );
      const value = bounds.min + (1 - ny) * (bounds.max - bounds.min);
      setDraftById((prev) => ({ ...prev, [keyframeId]: { frame, value } }));
    },
    [
      bounds.max,
      bounds.min,
      clientToGraphPoint,
      effective,
      frameWindowSpan,
      frameWindowStart,
      graphPadding.left,
      graphPadding.top,
      plotHeight,
      plotWidth,
      totalDuration,
      safeSnapStep,
    ],
  );

  const updateHandleFromPointer = useCallback(
    (keyframeId: string, handle: 'in' | 'out', clientX: number, clientY: number, breakMirror = false) => {
      const point = clientToGraphPoint(clientX, clientY);
      if (!point) return;
      const px = point.x;
      const py = point.y;
      const index = effective.findIndex((kf) => kf.id === keyframeId);
      if (index < 0) return;
      const current = effective[index];
      const existingHandles = current.bezierHandles ?? defaultBezierHandles();

      if (handle === 'out') {
        const next = effective[index + 1];
        if (!next) return;
        const x0 = toX(current.frame);
        const y0 = toY(current.value);
        const x1 = toX(next.frame);
        const y1 = toY(next.value);
        const dx = Math.abs(x1 - x0) < 1e-4 ? 1 : x1 - x0;
        const dy = Math.abs(y1 - y0) < 1e-4 ? 1 : y1 - y0;
        const outX = clamp01((px - x0) / dx);
        const outY = clamp01((py - y0) / dy);
        setDraftById((prev) => ({
          ...prev,
          [keyframeId]: {
            frame: current.frame,
            value: current.value,
            bezierHandles: {
              ...existingHandles,
              outX,
              outY,
              ...(breakMirror ? {} : { inX: clamp01(1 - outX), inY: clamp01(1 - outY) }),
            },
          },
        }));
        return;
      }

      const prevKeyframe = effective[index - 1];
      if (!prevKeyframe) return;
      const x0 = toX(prevKeyframe.frame);
      const y0 = toY(prevKeyframe.value);
      const x1 = toX(current.frame);
      const y1 = toY(current.value);
      const dx = Math.abs(x1 - x0) < 1e-4 ? 1 : x1 - x0;
      const dy = Math.abs(y1 - y0) < 1e-4 ? 1 : y1 - y0;
      const inX = clamp01((px - x0) / dx);
      const inY = clamp01((py - y0) / dy);
      setDraftById((prev) => ({
        ...prev,
        [keyframeId]: {
          frame: current.frame,
          value: current.value,
          bezierHandles: {
            ...existingHandles,
            inX,
            inY,
            ...(breakMirror ? {} : { outX: clamp01(1 - inX), outY: clamp01(1 - inY) }),
          },
        },
      }));
    },
    [clientToGraphPoint, effective, toX, toY],
  );

  useEffect(() => {
    if (!draggingPoint && !draggingHandle && !panning && !marquee) return;
    const onMove = (e: MouseEvent) => {
      if (marquee) {
        const point = clientToGraphPoint(e.clientX, e.clientY);
        if (!point) return;
        setMarquee((prev) =>
          prev
            ? {
                ...prev,
                currentX: point.x,
                currentY: point.y,
              }
            : prev,
        );
        return;
      }
      if (panning) {
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const dx = e.clientX - panning.anchorClientX;
        const deltaFrames = (dx / Math.max(1, rect.width)) * (graphWidth / plotWidth) * frameWindowSpan;
        applyFrameWindow(panning.startFrame - deltaFrames, panning.endFrame - deltaFrames);
        return;
      }
      if (draggingPoint) {
        updateFromPointer(draggingPoint.keyframeId, e.clientX, e.clientY, draggingPoint);
        return;
      }
      if (draggingHandle) {
        updateHandleFromPointer(
          draggingHandle.keyframeId,
          draggingHandle.handle,
          e.clientX,
          e.clientY,
          e.altKey,
        );
      }
    };
    const onUp = () => {
      if (marquee) {
        const minX = Math.min(marquee.startX, marquee.currentX);
        const maxX = Math.max(marquee.startX, marquee.currentX);
        const minY = Math.min(marquee.startY, marquee.currentY);
        const maxY = Math.max(marquee.startY, marquee.currentY);
        const hitRadius = 8;
        const nextIds = effective
          .filter((keyframe) => {
            if (!isFrameVisible(keyframe.frame)) return false;
            const x = toX(keyframe.frame);
            const y = toY(keyframe.value);
            return (
              x + hitRadius >= minX &&
              x - hitRadius <= maxX &&
              y + hitRadius >= minY &&
              y - hitRadius <= maxY
            );
          })
          .map((keyframe) => keyframe.id);
        onSetSelection?.(nextIds, nextIds[nextIds.length - 1] ?? null, {
          additive: marquee.additive,
        });
      }
      if (draggingPoint) {
        const draft = draftById[draggingPoint.keyframeId];
        if (draft) {
          onCommit(draggingPoint.keyframeId, { frame: draft.frame, value: draft.value });
        }
      }
      if (draggingHandle) {
        const draft = draftById[draggingHandle.keyframeId];
        if (draft?.bezierHandles) {
          onCommit(draggingHandle.keyframeId, { bezierHandles: draft.bezierHandles });
        }
      }
      setDraggingPoint(null);
      setDraggingHandle(null);
      setPanning(null);
      setMarquee(null);
      setDraftById((prev) => {
        const next = { ...prev };
        if (draggingPoint) delete next[draggingPoint.keyframeId];
        if (draggingHandle) delete next[draggingHandle.keyframeId];
        return next;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [
    clientToGraphPoint,
    applyFrameWindow,
    draggingPoint,
    draggingHandle,
    draftById,
    frameWindowSpan,
    marquee,
    onCommit,
    onSetSelection,
    panning,
    graphWidth,
    isFrameVisible,
    plotWidth,
    toX,
    toY,
    effective,
    updateFromPointer,
    updateHandleFromPointer,
  ]);

  const onGraphWheel = useCallback(
    (clientX: number, deltaY: number, shiftKey: boolean) => {
      const point = clientToGraphPoint(clientX, 0);
      if (!point) return;
      const nx = clamp01((point.x - graphPadding.left) / plotWidth);
      const focalFrame = frameWindowStart + nx * frameWindowSpan;
      const minSpan = minimumFrameWindowSpan;

      if (shiftKey) {
        const deltaFrames = (deltaY / 120) * Math.max(minSpan, frameWindowSpan * 0.18);
        applyFrameWindow(frameWindowStart + deltaFrames, frameWindowEnd + deltaFrames);
        return;
      }

      const zoomFactor = Math.exp(Math.max(-0.45, Math.min(0.45, deltaY * 0.0022)));
      let nextSpan = Math.max(minSpan, Math.min(totalDuration, frameWindowSpan * zoomFactor));
      if (totalDuration <= minSpan) nextSpan = totalDuration;

      const ratio = frameWindowSpan > 0 ? (focalFrame - frameWindowStart) / frameWindowSpan : 0.5;
      let nextStart = focalFrame - nextSpan * ratio;
      let nextEnd = nextStart + nextSpan;
      applyFrameWindow(nextStart, nextEnd);
    },
    [
      applyFrameWindow,
      frameWindowSpan,
      frameWindowStart,
      frameWindowEnd,
      minimumFrameWindowSpan,
      clientToGraphPoint,
      totalDuration,
      graphPadding.left,
      plotWidth,
    ],
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onGraphWheel(event.clientX, event.deltaY, event.shiftKey);
    };
    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', handleWheel);
    };
  }, [onGraphWheel]);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${graphWidth} ${graphHeight}`}
      className={`block h-[30rem] min-h-[30rem] w-full flex-none shrink-0 rounded border border-zinc-700 bg-zinc-900/50 ${
        panning ? 'cursor-grabbing' : 'cursor-default'
      }`}
      onDoubleClick={fitFrameWindow}
    >
      <defs>
        <clipPath id={clipPathId}>
          <rect
            x={graphPadding.left}
            y={graphPadding.top}
            width={plotWidth}
            height={plotHeight}
          />
        </clipPath>
      </defs>
      <rect
        x={0}
        y={0}
        width={graphWidth}
        height={graphHeight}
        fill="transparent"
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            setPanning({
              anchorClientX: e.clientX,
              startFrame: frameWindowStart,
              endFrame: frameWindowEnd,
            });
            return;
          }
          if (e.button !== 0) return;
          const point = clientToGraphPoint(e.clientX, e.clientY);
          if (!point) return;
          e.preventDefault();
          if (!(e.shiftKey || e.ctrlKey || e.metaKey)) {
            onSetSelection?.([], null, { additive: false });
          }
          setMarquee({
            startX: point.x,
            startY: point.y,
            currentX: point.x,
            currentY: point.y,
            additive: e.shiftKey || e.ctrlKey || e.metaKey,
          });
        }}
      />
      {verticalTicks.map((frame) => {
        const x = toX(frame);
        return (
          <g key={`grid-x-${frame}`} pointerEvents="none">
            <line
              x1={x}
              y1={graphPadding.top}
              x2={x}
              y2={graphHeight - graphPadding.bottom}
              stroke="#1f2937"
              strokeWidth="1"
              strokeDasharray="2.5 3.5"
            />
            <text
              x={Math.min(graphWidth - 28, x + 4)}
              y={graphHeight - 8}
              fill="#475569"
              fontSize="11"
              fontFamily="monospace"
            >
              {frame}f
            </text>
          </g>
        );
      })}
      {horizontalTicks.map((value, index) => {
        const y = toY(value);
        return (
          <g key={`grid-y-${index}`} pointerEvents="none">
            <line
              x1={graphPadding.left}
              y1={y}
              x2={graphWidth - graphPadding.right}
              y2={y}
              stroke="#111827"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            <text
              x={8}
              y={Math.max(14, Math.min(graphHeight - 12, y - 4))}
              fill="#475569"
              fontSize="11"
              fontFamily="monospace"
            >
              {value.toFixed(Math.abs(value) >= 10 ? 0 : 2)}
            </text>
          </g>
        );
      })}
      <line
        x1={currentX}
        y1={graphPadding.top}
        x2={currentX}
        y2={graphHeight - graphPadding.bottom}
        stroke="#334155"
        strokeWidth="1.5"
        pointerEvents="none"
      />
      <text x={graphPadding.left} y={14} fill="#64748b" fontSize="11" fontFamily="monospace" pointerEvents="none">
        {`${Math.round(frameWindowStart)}f-${Math.round(frameWindowEnd)}f | snap ${safeSnapStep}f`}
      </text>
      <g clipPath={`url(#${clipPathId})`}>
      <path fill="none" stroke="#60a5fa" strokeWidth="3" d={curvePath} pointerEvents="none" />
      {effective.map((k, index) => {
        if (!isFrameVisible(k.frame)) return null;
        if (k.easing !== 'bezier') return null;
        const showHandles =
          selectedIdsSet.has(k.id) || draggingHandle?.keyframeId === k.id;
        if (!showHandles) return null;
        const handles = k.bezierHandles ?? defaultBezierHandles();
        const x = toX(k.frame);
        const y = toY(k.value);
        const prev = index > 0 ? effective[index - 1] : null;
        const next = index < effective.length - 1 ? effective[index + 1] : null;
        const prevX = prev ? toX(prev.frame) : null;
        const prevY = prev ? toY(prev.value) : null;
        const nextX = next ? toX(next.frame) : null;
        const nextY = next ? toY(next.value) : null;
        const inHX = prevX == null ? null : prevX + (x - prevX) * clamp01(handles.inX);
        const inHY = prevY == null ? null : prevY + (y - prevY) * clamp01(handles.inY);
        const outHX = nextX == null ? null : x + (nextX - x) * clamp01(handles.outX);
        const outHY = nextY == null ? null : y + (nextY - y) * clamp01(handles.outY);
        return (
          <g key={`handle-${k.id}`}>
            {inHX != null && inHY != null && (
              <>
                <line x1={x} y1={y} x2={inHX} y2={inHY} stroke="#64748b" strokeWidth="1.1" />
                <circle
                  cx={inHX}
                  cy={inHY}
                  r="6"
                  fill="#94a3b8"
                  stroke="#0f172a"
                  strokeWidth="1.4"
                  className="cursor-crosshair"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectKeyframe?.(k.id);
                    setDraggingHandle({ keyframeId: k.id, handle: 'in' });
                  }}
                />
              </>
            )}
            {outHX != null && outHY != null && (
              <>
                <line x1={x} y1={y} x2={outHX} y2={outHY} stroke="#64748b" strokeWidth="1.1" />
                <circle
                  cx={outHX}
                  cy={outHY}
                  r="6"
                  fill="#94a3b8"
                  stroke="#0f172a"
                  strokeWidth="1.4"
                  className="cursor-crosshair"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectKeyframe?.(k.id);
                    setDraggingHandle({ keyframeId: k.id, handle: 'out' });
                  }}
                />
              </>
            )}
          </g>
        );
      })}
      {effective.map((k) => {
        if (!isFrameVisible(k.frame)) return null;
        const x = toX(k.frame);
        const y = toY(k.value);
        const isSelected = selectedIdsSet.has(k.id);
        return (
          <circle
            key={k.id}
            cx={x}
            cy={y}
            r={isSelected ? 8 : 7}
            fill={draggingPoint?.keyframeId === k.id ? '#bfdbfe' : isSelected ? '#fef08a' : '#93c5fd'}
            stroke={isSelected ? '#f59e0b' : '#1e293b'}
            strokeWidth="1.8"
            className="cursor-pointer"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const isAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
              onSelectKeyframe?.(k.id, isAdditive ? { additive: true } : undefined);
              if (isAdditive) return;
              const index = sorted.findIndex((candidate) => candidate.id === k.id);
              const minFrame = index > 0 ? sorted[index - 1]!.frame + safeSnapStep : 0;
              const maxFrame =
                index >= 0 && index < sorted.length - 1
                  ? sorted[index + 1]!.frame - safeSnapStep
                  : totalDuration;
              setDraggingPoint({ keyframeId: k.id, minFrame, maxFrame });
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelectKeyframe?.(k.id);
              onToggleKeyframeCurve?.(k.id);
            }}
          />
        );
      })}
      </g>
      {marquee && (
        <rect
          x={Math.min(marquee.startX, marquee.currentX)}
          y={Math.min(marquee.startY, marquee.currentY)}
          width={Math.abs(marquee.currentX - marquee.startX)}
          height={Math.abs(marquee.currentY - marquee.startY)}
          fill="rgba(96, 165, 250, 0.12)"
          stroke="#60a5fa"
          strokeWidth="0.8"
          strokeDasharray="1.6 1.6"
          pointerEvents="none"
        />
      )}
    </svg>
  );
}

function InlineKeyframeControls({
  active,
  label,
  currentFrame,
  onToggle,
  onPrev,
  onAdd,
  onNext,
  onClear,
  disableNav = false,
  disableAdd = false,
  disableClear = false,
}: {
  active: boolean;
  label: string;
  currentFrame: number;
  onToggle: () => void;
  onPrev: () => void;
  onAdd: () => void;
  onNext: () => void;
  onClear?: () => void;
  disableNav?: boolean;
  disableAdd?: boolean;
  disableClear?: boolean;
}) {
  const frameLabel = `${Math.max(0, Math.round(currentFrame))}f`;

  return (
    <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
      <div className="flex items-center gap-1">
        <IconActionButton
          title={
            active
              ? `Disable ${label} keyframes (with confirmation)`
              : `Enable ${label} keyframes and add keyframe at playhead`
          }
          onClick={onToggle}
          active={active}
        >
          <ClockGlyph />
        </IconActionButton>
        <span className="rounded bg-zinc-900/60 px-1 py-0.5 font-mono text-zinc-500">
          {frameLabel}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <IconActionButton title={`Previous ${label} keyframe`} onClick={onPrev} disabled={disableNav}>
          <PrevGlyph />
        </IconActionButton>
        <IconActionButton title={`Add/update ${label} keyframe at playhead`} onClick={onAdd} disabled={disableAdd}>
          <AddKeyGlyph />
        </IconActionButton>
        <IconActionButton title={`Next ${label} keyframe`} onClick={onNext} disabled={disableNav}>
          <NextGlyph />
        </IconActionButton>
        {onClear && (
          <IconActionButton
            title={`Delete ${label} keyframes`}
            onClick={onClear}
            disabled={disableClear}
            destructive
          >
            <TrashGlyph />
          </IconActionButton>
        )}
      </div>
    </div>
  );
}

export function Inspector({ onToggleCollapse }: { onToggleCollapse?: () => void }) {
  const setActivePanel = useSelectionStore((s) => s.setActivePanel);
  const activePanel = useSelectionStore((s) => s.activePanel);
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const activeMaskClipId = useSelectionStore((s) => s.activeMaskClipId);
  const activeMaskId = useSelectionStore((s) => s.activeMaskId);
  const setActiveMaskSelection = useSelectionStore((s) => s.setActiveMaskSelection);
  const linkScale = useSelectionStore((s) => s.linkedScale);
  const setLinkScale = useSelectionStore((s) => s.setLinkedScale);
  const autoKeyframeEnabled = useSelectionStore((s) => s.autoKeyframeEnabled);
  const sourceAsset = useSelectionStore((s) => s.sourceAsset);
  const sourceInTime = useSelectionStore((s) => s.sourceInTime);
  const sourceOutTime = useSelectionStore((s) => s.sourceOutTime);
  const sequences = useProjectStore((s) => s.sequences);
  const mediaAssets = useProjectStore((s) => s.mediaAssets);
  const updateClipProperties = useProjectStore((s) => s.updateClipProperties);
  const upsertClipKeyframe = useProjectStore((s) => s.upsertClipKeyframe);
  const removeClipKeyframe = useProjectStore((s) => s.removeClipKeyframe);
  const setClipTransition = useProjectStore((s) => s.setClipTransition);
  const addClipMask = useProjectStore((s) => s.addClipMask);
  const updateClipMask = useProjectStore((s) => s.updateClipMask);
  const removeClipMask = useProjectStore((s) => s.removeClipMask);
  const upsertMaskShapeKeyframe = useProjectStore((s) => s.upsertMaskShapeKeyframe);
  const removeMaskShapeKeyframe = useProjectStore((s) => s.removeMaskShapeKeyframe);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const fps = usePlaybackStore((s) => s.fps);

  const [transformOpen, setTransformOpen] = useState(true);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [compositingOpen, setCompositingOpen] = useState(false);
  const [transitionsOpen, setTransitionsOpen] = useState(false);
  const [masksOpen, setMasksOpen] = useState(false);
  const [selectedMaskKeyframeId, setSelectedMaskKeyframeId] = useState<string | null>(null);

  const selectedClip: TimelineClipData | null = (() => {
    if (selectedClipIds.size !== 1) return null;
    const clipId = Array.from(selectedClipIds)[0];
    if (!sequences.length) return null;
    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];
    for (const track of tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  })();

  const selectedClipTrack: TimelineTrackData | null = (() => {
    if (!selectedClip) return null;
    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];
    return tracks.find((t) => t.clips.some((c) => c.id === selectedClip.id)) ?? null;
  })();

  const transitionLimitBySide = useMemo(() => {
    if (!selectedClip || !selectedClipTrack) {
      return { in: null, out: null } as const;
    }
    const defaultDuration = Math.max(1, Math.round(fps * 0.5));
    return {
      in: computeTransitionSideLimit({
        track: selectedClipTrack,
        clip: selectedClip,
        side: 'in',
        type: (selectedClip.transitionIn?.type ?? 'cross-dissolve') as 'cross-dissolve' | 'fade-black',
        requestedDurationFrames: selectedClip.transitionIn?.durationFrames ?? defaultDuration,
        mediaAssets,
        fps,
      }),
      out: computeTransitionSideLimit({
        track: selectedClipTrack,
        clip: selectedClip,
        side: 'out',
        type: (selectedClip.transitionOut?.type ?? 'cross-dissolve') as 'cross-dissolve' | 'fade-black',
        requestedDurationFrames: selectedClip.transitionOut?.durationFrames ?? defaultDuration,
        mediaAssets,
        fps,
      }),
    } as const;
  }, [selectedClip, selectedClipTrack, mediaAssets, fps]);

  const clipAsset = selectedClip?.mediaAssetId
    ? (mediaAssets.find((a) => a.id === selectedClip.mediaAssetId) ?? null)
    : null;

  const linkedAudioClip: TimelineClipData | null = (() => {
    if (!selectedClip?.linkedClipId) return null;
    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];
    for (const t of tracks) {
      const c = t.clips.find((x) => x.id === selectedClip.linkedClipId);
      if (c) return c;
    }
    return null;
  })();

  const audioControlClip =
    selectedClip?.type === 'audio'
      ? selectedClip
      : linkedAudioClip?.type === 'audio'
        ? linkedAudioClip
        : null;
  const isVisualClip = selectedClip?.type !== 'audio';

  const hasClipSelection = selectedClipIds.size > 0;
  const seqResolution = sequences[0]?.resolution ?? { width: 1920, height: 1080 };

  const scaleX = selectedClip?.scaleX ?? 1;
  const scaleY = selectedClip?.scaleY ?? 1;
  const speed = selectedClip?.speed ?? 1;
  const speedMagnitude = Math.max(0.1, Math.min(4, Math.abs(speed)));

  const baseWidth = clipAsset?.resolution?.width ?? seqResolution.width;
  const baseHeight = clipAsset?.resolution?.height ?? seqResolution.height;

  const widthPx = Math.round(baseWidth * Math.abs(scaleX));
  const heightPx = Math.round(baseHeight * Math.abs(scaleY));

  const getClipLocalFrame = useCallback(
    (clip: TimelineClipData | null): number => {
      if (!clip) return 0;
      return Math.max(0, Math.min(clip.durationFrames, currentFrame - clip.startFrame));
    },
    [currentFrame],
  );

  const getClipPropertyKeyframes = useCallback(
    (clip: TimelineClipData | null, property: KeyframeProperty) => {
      if (!clip) return [];
      return [...(clip.keyframes ?? [])]
        .filter((kf) => kf.property === property)
        .sort((a, b) => a.frame - b.frame);
    },
    [],
  );

  const resolveAutoKeyProperty = useCallback(
    (
      key: keyof TimelineClipData,
    ): NonNullable<TimelineClipData['keyframes']>[number]['property'] | null => {
      if (key === 'positionX') return 'transform.positionX';
      if (key === 'positionY') return 'transform.positionY';
      if (key === 'scaleX') return 'transform.scaleX';
      if (key === 'scaleY') return 'transform.scaleY';
      if (key === 'rotation') return 'transform.rotation';
      if (key === 'opacity') return 'opacity';
      if (key === 'speed') return 'speed';
      if (key === 'brightness') return 'brightness';
      if (key === 'contrast') return 'contrast';
      if (key === 'saturation') return 'saturation';
      if (key === 'hue') return 'hue';
      if (key === 'vignette') return 'vignette';
      if (key === 'pan' || key === 'audioPan') return 'pan';
      if (key === 'gain' || key === 'audioVolume' || key === 'audioGainDb') return 'volume';
      return null;
    },
    [],
  );

  const upsertPropertyKeyframeValue = useCallback(
    (
      clip: TimelineClipData,
      property: KeyframeProperty,
      value: number,
      forceForClockedProperty = false,
    ) => {
      const keyframes = getClipPropertyKeyframes(clip, property);
      if (!forceForClockedProperty && !autoKeyframeEnabled && keyframes.length === 0) {
        return;
      }
      const localFrame = Math.max(0, Math.min(clip.durationFrames, currentFrame - clip.startFrame));
      const existing = keyframes.find((kf) => kf.frame === localFrame);
      void upsertClipKeyframe(clip.id, {
        id: existing?.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12),
        property,
        frame: localFrame,
        value,
        easing: existing?.easing ?? 'linear',
        bezierHandles: existing?.bezierHandles,
      });
    },
    [autoKeyframeEnabled, currentFrame, getClipPropertyKeyframes, upsertClipKeyframe],
  );

  const updateProp = useCallback(
    (key: keyof TimelineClipData, value: number) => {
      if (!selectedClip) return;
      void updateClipProperties(selectedClip.id, { [key]: value });
      const property = resolveAutoKeyProperty(key);
      if (!property) return;
      const hasClockedKeyframes = getClipPropertyKeyframes(selectedClip, property).length > 0;
      upsertPropertyKeyframeValue(selectedClip, property, value, hasClockedKeyframes);
    },
    [
      selectedClip,
      updateClipProperties,
      resolveAutoKeyProperty,
      getClipPropertyKeyframes,
      upsertPropertyKeyframeValue,
    ],
  );

  const updateScaleX = useCallback(
    (v: number) => {
      if (!selectedClip) return;
      const next = clampScale(v);
      const scaleXClocked = getClipPropertyKeyframes(selectedClip, 'transform.scaleX').length > 0;
      const scaleYClocked = getClipPropertyKeyframes(selectedClip, 'transform.scaleY').length > 0;
      const keepLinkedKeyframes = linkScale && (scaleXClocked || scaleYClocked);
      if (linkScale) {
        const sySign = (selectedClip.scaleY ?? 1) < 0 ? -1 : 1;
        const nextY = clampScale(Math.abs(next) * sySign);
        void updateClipProperties(selectedClip.id, {
          scaleX: next,
          scaleY: nextY,
        });
        upsertPropertyKeyframeValue(selectedClip, 'transform.scaleX', next, keepLinkedKeyframes);
        upsertPropertyKeyframeValue(selectedClip, 'transform.scaleY', nextY, keepLinkedKeyframes);
      } else {
        void updateClipProperties(selectedClip.id, { scaleX: next });
        upsertPropertyKeyframeValue(selectedClip, 'transform.scaleX', next, scaleXClocked);
      }
    },
    [selectedClip, linkScale, updateClipProperties, getClipPropertyKeyframes, upsertPropertyKeyframeValue],
  );

  const updateScaleY = useCallback(
    (v: number) => {
      if (!selectedClip) return;
      const next = clampScale(v);
      const scaleXClocked = getClipPropertyKeyframes(selectedClip, 'transform.scaleX').length > 0;
      const scaleYClocked = getClipPropertyKeyframes(selectedClip, 'transform.scaleY').length > 0;
      const keepLinkedKeyframes = linkScale && (scaleXClocked || scaleYClocked);
      if (linkScale) {
        const sxSign = (selectedClip.scaleX ?? 1) < 0 ? -1 : 1;
        const nextX = clampScale(Math.abs(next) * sxSign);
        void updateClipProperties(selectedClip.id, {
          scaleX: nextX,
          scaleY: next,
        });
        upsertPropertyKeyframeValue(selectedClip, 'transform.scaleX', nextX, keepLinkedKeyframes);
        upsertPropertyKeyframeValue(selectedClip, 'transform.scaleY', next, keepLinkedKeyframes);
      } else {
        void updateClipProperties(selectedClip.id, { scaleY: next });
        upsertPropertyKeyframeValue(selectedClip, 'transform.scaleY', next, scaleYClocked);
      }
    },
    [selectedClip, linkScale, updateClipProperties, getClipPropertyKeyframes, upsertPropertyKeyframeValue],
  );

  const fitToFrame = useCallback(() => {
    if (!selectedClip || !clipAsset) return;
    const srcW = clipAsset.resolution?.width ?? seqResolution.width;
    const srcH = clipAsset.resolution?.height ?? seqResolution.height;
    const fitX = seqResolution.width / Math.max(1, srcW);
    const fitY = seqResolution.height / Math.max(1, srcH);
    const sxSign = (selectedClip.scaleX ?? 1) < 0 ? -1 : 1;
    const sySign = (selectedClip.scaleY ?? 1) < 0 ? -1 : 1;
    const nextScaleX = clampScale(fitX * sxSign);
    const nextScaleY = clampScale(fitY * sySign);
    void updateClipProperties(selectedClip.id, {
      scaleX: nextScaleX,
      scaleY: nextScaleY,
      positionX: 0,
      positionY: 0,
    });
    const scaleXClocked = getClipPropertyKeyframes(selectedClip, 'transform.scaleX').length > 0;
    const scaleYClocked = getClipPropertyKeyframes(selectedClip, 'transform.scaleY').length > 0;
    const posXClocked = getClipPropertyKeyframes(selectedClip, 'transform.positionX').length > 0;
    const posYClocked = getClipPropertyKeyframes(selectedClip, 'transform.positionY').length > 0;
    upsertPropertyKeyframeValue(selectedClip, 'transform.scaleX', nextScaleX, scaleXClocked);
    upsertPropertyKeyframeValue(selectedClip, 'transform.scaleY', nextScaleY, scaleYClocked);
    upsertPropertyKeyframeValue(selectedClip, 'transform.positionX', 0, posXClocked);
    upsertPropertyKeyframeValue(selectedClip, 'transform.positionY', 0, posYClocked);
  }, [
    selectedClip,
    clipAsset,
    seqResolution.width,
    seqResolution.height,
    updateClipProperties,
    getClipPropertyKeyframes,
    upsertPropertyKeyframeValue,
  ]);

  const updateWidth = useCallback(
    (w: number) => {
      if (!selectedClip) return;
      const sign = (selectedClip.scaleX ?? 1) < 0 ? -1 : 1;
      const next = clampScale((Math.max(1, w) / Math.max(1, baseWidth)) * sign);
      updateScaleX(next);
    },
    [selectedClip, baseWidth, updateScaleX],
  );

  const updateHeight = useCallback(
    (h: number) => {
      if (!selectedClip) return;
      const sign = (selectedClip.scaleY ?? 1) < 0 ? -1 : 1;
      const next = clampScale((Math.max(1, h) / Math.max(1, baseHeight)) * sign);
      updateScaleY(next);
    },
    [selectedClip, baseHeight, updateScaleY],
  );

  const clipLocalFrame = selectedClip
    ? Math.max(0, Math.min(selectedClip.durationFrames, currentFrame - selectedClip.startFrame))
    : 0;

  const clipMasks = useMemo(() => selectedClip?.masks ?? [], [selectedClip?.masks]);
  const selectedMask = useMemo(
    () => {
      const effectiveMaskId = selectedClip?.id != null && activeMaskClipId === selectedClip.id ? activeMaskId : null;
      return clipMasks.find((m) => m.id === effectiveMaskId) ?? clipMasks[0] ?? null;
    },
    [clipMasks, selectedClip?.id, activeMaskClipId, activeMaskId],
  );

  const selectedMaskKeyframes = useMemo(
    () => [...(selectedMask?.keyframes ?? [])].sort((a, b) => a.frame - b.frame),
    [selectedMask?.keyframes],
  );
  const selectedMaskKeyframe = useMemo(() => {
    if (!selectedMaskKeyframes.length) return null;
    if (selectedMaskKeyframeId) {
      const explicit = selectedMaskKeyframes.find((kf) => kf.id === selectedMaskKeyframeId);
      if (explicit) return explicit;
    }
    const exact = selectedMaskKeyframes.find((kf) => kf.frame === clipLocalFrame);
    if (exact) return exact;
    const before = [...selectedMaskKeyframes].reverse().find((kf) => kf.frame <= clipLocalFrame);
    return before ?? selectedMaskKeyframes[0] ?? null;
  }, [selectedMaskKeyframes, selectedMaskKeyframeId, clipLocalFrame]);

  useEffect(() => {
    if (!selectedMaskKeyframe) {
      setSelectedMaskKeyframeId(null);
      return;
    }
    if (selectedMaskKeyframeId !== selectedMaskKeyframe.id) {
      setSelectedMaskKeyframeId(selectedMaskKeyframe.id);
    }
  }, [selectedMaskKeyframe, selectedMaskKeyframeId]);

  const cloneMaskPoints = useCallback((points: MaskPoint[]): MaskPoint[] => {
    return points.map((p) => ({
      x: p.x,
      y: p.y,
      inX: p.inX,
      inY: p.inY,
      outX: p.outX,
      outY: p.outY,
    }));
  }, []);

  const defaultMaskPoints = useCallback((): MaskPoint[] => {
    const insetX = baseWidth * 0.15;
    const insetY = baseHeight * 0.15;
    const left = insetX;
    const top = insetY;
    const right = baseWidth - insetX;
    const bottom = baseHeight - insetY;
    return [
      { x: left, y: top, inX: left, inY: top, outX: left, outY: top },
      { x: right, y: top, inX: right, inY: top, outX: right, outY: top },
      { x: right, y: bottom, inX: right, inY: bottom, outX: right, outY: bottom },
      { x: left, y: bottom, inX: left, inY: bottom, outX: left, outY: bottom },
    ];
  }, [baseHeight, baseWidth]);

  const getPropertyValueAtCurrent = useCallback(
    (clip: TimelineClipData | null, property: KeyframeProperty): number => {
      if (!clip) return 0;
      switch (property) {
        case 'speed':
          return clip.speed ?? 1;
        case 'volume': {
          const db = clip.audioGainDb ?? gainToDb(clip.gain ?? clip.audioVolume ?? 1);
          return Math.max(0, dbToGain(db));
        }
        case 'pan':
          return clip.pan ?? clip.audioPan ?? 0;
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
          return clip.positionX ?? 0;
        case 'transform.positionY':
          return clip.positionY ?? 0;
        case 'transform.scaleX':
          return clip.scaleX ?? 1;
        case 'transform.scaleY':
          return clip.scaleY ?? 1;
        case 'transform.rotation':
          return clip.rotation ?? 0;
        case 'transform.anchorX':
        case 'transform.anchorY':
          return 0.5;
        case 'opacity':
          return clip.opacity ?? 1;
        case 'mask.opacity':
          return (clip.id === selectedClip?.id ? selectedMask?.opacity : clip.masks?.[0]?.opacity) ?? 1;
        case 'mask.feather':
          return (clip.id === selectedClip?.id ? selectedMask?.feather : clip.masks?.[0]?.feather) ?? 0;
        case 'mask.expansion':
          return (clip.id === selectedClip?.id
            ? selectedMask?.expansion
            : clip.masks?.[0]?.expansion) ?? 0;
        default:
          return 0;
      }
    },
    [
      selectedClip?.id,
      selectedMask?.opacity,
      selectedMask?.feather,
      selectedMask?.expansion,
    ],
  );

  const addOrUpdatePropertyKeyframe = useCallback(
    (property: KeyframeProperty, clipOverride?: TimelineClipData | null) => {
      const targetClip = clipOverride ?? selectedClip;
      if (!targetClip) return;
      const frame = getClipLocalFrame(targetClip);
      const existing = getClipPropertyKeyframes(targetClip, property).find((kf) => kf.frame === frame);
      void upsertClipKeyframe(targetClip.id, {
        id: existing?.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12),
        property,
        frame,
        value: getPropertyValueAtCurrent(targetClip, property),
        easing: existing?.easing ?? 'linear',
        bezierHandles: existing?.bezierHandles,
      });
    },
    [
      selectedClip,
      getClipLocalFrame,
      getClipPropertyKeyframes,
      upsertClipKeyframe,
      getPropertyValueAtCurrent,
    ],
  );

  const jumpPropertyKeyframe = useCallback(
    (property: KeyframeProperty, direction: -1 | 1, clipOverride?: TimelineClipData | null) => {
      const targetClip = clipOverride ?? selectedClip;
      if (!targetClip) return;
      const localFrame = getClipLocalFrame(targetClip);
      const keyframes = getClipPropertyKeyframes(targetClip, property);
      if (keyframes.length === 0) return;
      if (direction < 0) {
        const prev = [...keyframes].reverse().find((kf) => kf.frame < localFrame);
        const target = prev ?? keyframes[0];
        setCurrentFrame(Math.max(0, targetClip.startFrame + target.frame));
        return;
      }
      const next = keyframes.find((kf) => kf.frame > localFrame);
      const target = next ?? keyframes[keyframes.length - 1];
      setCurrentFrame(Math.max(0, targetClip.startFrame + target.frame));
    },
    [selectedClip, getClipLocalFrame, getClipPropertyKeyframes, setCurrentFrame],
  );

  const togglePropertyKeyframes = useCallback(
    (property: KeyframeProperty, label: string, clipOverride?: TimelineClipData | null) => {
      const targetClip = clipOverride ?? selectedClip;
      if (!targetClip) return;
      const linkedScaleProperties: KeyframeProperty[] =
        linkScale && (property === 'transform.scaleX' || property === 'transform.scaleY')
          ? ['transform.scaleX', 'transform.scaleY']
          : [property];

      const keyframesByProperty = linkedScaleProperties.map((item) => ({
        property: item,
        keyframes: getClipPropertyKeyframes(targetClip, item),
      }));
      const hasAnyKeyframes = keyframesByProperty.some((item) => item.keyframes.length > 0);

      if (!hasAnyKeyframes) {
        for (const item of linkedScaleProperties) {
          addOrUpdatePropertyKeyframe(item, targetClip);
        }
        return;
      }

      const promptLabel =
        linkedScaleProperties.length === 2 ? 'Width/Height' : label;
      const shouldClear = window.confirm(
        `Delete all ${promptLabel} keyframes on this clip? This cannot be undone with one click.`,
      );
      if (!shouldClear) return;

      for (const item of keyframesByProperty) {
        for (const keyframe of item.keyframes) {
          void removeClipKeyframe(targetClip.id, keyframe.id);
        }
      }
    },
    [
      selectedClip,
      getClipPropertyKeyframes,
      addOrUpdatePropertyKeyframe,
      removeClipKeyframe,
      linkScale,
    ],
  );

  const addMask = useCallback(() => {
    if (!selectedClip) return;
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const keyframeId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const maskCount = clipMasks.length + 1;
    const mask: ManualMaskData = {
      id,
      name: `Mask ${maskCount}`,
      mode: 'add',
      closed: true,
      invert: false,
      opacity: 1,
      feather: 0,
      expansion: 0,
      keyframes: [
        {
          id: keyframeId,
          frame: clipLocalFrame,
          points: defaultMaskPoints(),
        },
      ],
    };
    void addClipMask(selectedClip.id, mask);
    setActiveMaskSelection(selectedClip.id, id);
    setSelectedMaskKeyframeId(keyframeId);
  }, [selectedClip, clipMasks.length, clipLocalFrame, defaultMaskPoints, addClipMask, setActiveMaskSelection]);

  const removeSelectedMask = useCallback(() => {
    if (!selectedClip || !selectedMask) return;
    void removeClipMask(selectedClip.id, selectedMask.id);
  }, [selectedClip, selectedMask, removeClipMask]);

  const updateSelectedMask = useCallback(
    (patch: Partial<Omit<ManualMaskData, 'id'>>) => {
      if (!selectedClip || !selectedMask) return;
      void updateClipMask(selectedClip.id, selectedMask.id, patch);
    },
    [selectedClip, selectedMask, updateClipMask],
  );

  const upsertSelectedMaskKeyframe = useCallback(
    (keyframe: MaskShapeKeyframe) => {
      if (!selectedClip || !selectedMask) return;
      void upsertMaskShapeKeyframe(selectedClip.id, selectedMask.id, keyframe);
      setSelectedMaskKeyframeId(keyframe.id);
    },
    [selectedClip, selectedMask, upsertMaskShapeKeyframe],
  );

  const addMaskKeyframeAtPlayhead = useCallback(() => {
    if (!selectedMask) return;
    const existingAtFrame = selectedMask.keyframes.find((kf) => kf.frame === clipLocalFrame);
    const pointsSource = selectedMaskKeyframe?.points ?? defaultMaskPoints();
    upsertSelectedMaskKeyframe({
      id: existingAtFrame?.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      frame: clipLocalFrame,
      points: cloneMaskPoints(pointsSource),
    });
  }, [
    selectedMask,
    clipLocalFrame,
    selectedMaskKeyframe,
    defaultMaskPoints,
    upsertSelectedMaskKeyframe,
    cloneMaskPoints,
  ]);

  const removeSelectedMaskKeyframe = useCallback(() => {
    if (!selectedClip || !selectedMask || !selectedMaskKeyframe) return;
    void removeMaskShapeKeyframe(selectedClip.id, selectedMask.id, selectedMaskKeyframe.id);
  }, [selectedClip, selectedMask, selectedMaskKeyframe, removeMaskShapeKeyframe]);

  const jumpMaskKeyframe = useCallback(
    (direction: -1 | 1) => {
      if (!selectedMaskKeyframes.length || !selectedClip) return;
      const sorted = selectedMaskKeyframes;
      if (direction < 0) {
        const prev = [...sorted].reverse().find((kf) => kf.frame < clipLocalFrame);
        if (!prev) return;
        setCurrentFrame(selectedClip.startFrame + prev.frame);
      } else {
        const next = sorted.find((kf) => kf.frame > clipLocalFrame);
        if (!next) return;
        setCurrentFrame(selectedClip.startFrame + next.frame);
      }
    },
    [selectedMaskKeyframes, selectedClip, clipLocalFrame, setCurrentFrame],
  );

  const updateTransitionDuration = useCallback(
    (side: 'in' | 'out', durationFrames: number) => {
      if (!selectedClip) return;
      const existing = side === 'in' ? selectedClip.transitionIn : selectedClip.transitionOut;
      if (!existing) return;
      void setClipTransition(selectedClip.id, side, {
        ...existing,
        durationFrames: Math.max(1, Math.round(durationFrames)),
      });
    },
    [selectedClip, setClipTransition],
  );

  const setTransitionType = useCallback(
    (side: 'in' | 'out', type: 'none' | 'cross-dissolve' | 'fade-black') => {
      if (!selectedClip) return;
      if (type === 'none') {
        void setClipTransition(selectedClip.id, side, null);
        return;
      }
      const existing = side === 'in' ? selectedClip.transitionIn : selectedClip.transitionOut;
      void setClipTransition(selectedClip.id, side, {
        id: existing?.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12),
        type,
        durationFrames: Math.max(1, existing?.durationFrames ?? Math.round(fps * 0.5)),
        audioCrossfade: existing?.audioCrossfade ?? type === 'cross-dissolve',
      });
    },
    [selectedClip, setClipTransition, fps],
  );

  const onInspectorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (activePanel !== 'inspector') return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.stopPropagation();
        return;
      }
      if (!selectedClip) return;
      const target = e.target as HTMLElement;
      const sliders = Array.from(
        target.closest('aside')?.querySelectorAll('input[type="range"]') ?? [],
      ) as HTMLInputElement[];
      if (!sliders.length) return;
      const focused = document.activeElement as HTMLInputElement | null;
      const index = sliders.findIndex((s) => s === focused);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const next = sliders[Math.min(sliders.length - 1, Math.max(0, index + 1))] ?? sliders[0];
        next.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const prev = sliders[Math.max(0, index - 1)] ?? sliders[0];
        prev.focus();
      }
    },
    [activePanel, selectedClip],
  );

  const speedLabel = useMemo(() => `${(speed * 100).toFixed(0)}%`, [speed]);

  const renderInlineKeyframeControls = useCallback(
    (property: KeyframeProperty, label: string, clipOverride?: TimelineClipData | null) => {
      const targetClip = clipOverride ?? selectedClip;
      if (!targetClip) return undefined;
      const hasKeyframes = getClipPropertyKeyframes(targetClip, property).length > 0;
      const localFrame = getClipLocalFrame(targetClip);
      return {
        left: (
          <IconActionButton
            title={
              hasKeyframes
                ? `Disable ${label} keyframes (with confirmation)`
                : `Enable ${label} keyframes and add keyframe at playhead`
            }
            onClick={() => togglePropertyKeyframes(property, label, targetClip)}
            active={hasKeyframes}
          >
            <ClockGlyph />
          </IconActionButton>
        ),
        right: (
          <>
            <IconActionButton
              title={`Previous ${label} keyframe`}
              onClick={() => jumpPropertyKeyframe(property, -1, targetClip)}
              disabled={!hasKeyframes}
            >
              <PrevGlyph />
            </IconActionButton>
            <span className="rounded bg-zinc-900/60 px-1 py-0.5 font-mono text-[10px] text-zinc-500">
              {Math.max(0, Math.round(localFrame))}f
            </span>
            <IconActionButton
              title={`Add/update ${label} keyframe at playhead`}
              onClick={() => addOrUpdatePropertyKeyframe(property, targetClip)}
            >
              <AddKeyGlyph />
            </IconActionButton>
            <IconActionButton
              title={`Next ${label} keyframe`}
              onClick={() => jumpPropertyKeyframe(property, 1, targetClip)}
              disabled={!hasKeyframes}
            >
              <NextGlyph />
            </IconActionButton>
          </>
        ),
      } satisfies SliderRailControls;
    },
    [
      addOrUpdatePropertyKeyframe,
      getClipLocalFrame,
      getClipPropertyKeyframes,
      jumpPropertyKeyframe,
      selectedClip,
      togglePropertyKeyframes,
    ],
  );

  return (
    <aside
      className="flex w-[24rem] flex-shrink-0 flex-col overflow-y-auto border-l border-zinc-700 bg-zinc-800/50 text-zinc-300"
      tabIndex={0}
      onMouseDown={() => setActivePanel('inspector')}
      onKeyDown={onInspectorKeyDown}
    >
      <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Inspector</h2>
        <button
          className="rounded bg-zinc-700 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-600"
          onClick={onToggleCollapse}
          title="Collapse inspector panel"
        >
          ▶
        </button>
      </div>

      {hasClipSelection && selectedClip ? (
        <>
          <StaticSection title="Clip">
            <Row label="Name" value={selectedClip.name} />
            <Row label="Type" value={selectedClip.type} />
            {selectedClipTrack && <Row label="Track" value={selectedClipTrack.name} />}
          </StaticSection>

          {isVisualClip && (
            <CollapsibleSection
              title="Transform"
              open={transformOpen}
              onToggle={() => setTransformOpen((v) => !v)}
            >
              <div className="flex items-center gap-1">
                <button
                  className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
                  onClick={() =>
                    void updateClipProperties(selectedClip.id, {
                      positionX: 0,
                      positionY: 0,
                      scaleX: 1,
                      scaleY: 1,
                      rotation: 0,
                      opacity: 1,
                    })
                  }
                  title="Reset transform"
                >
                  Reset
                </button>
                <button
                  className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
                  onClick={() =>
                    void updateClipProperties(selectedClip.id, {
                      scaleX: clampScale(-(selectedClip.scaleX ?? 1)),
                    })
                  }
                  title="Flip horizontal"
                >
                  ⇋
                </button>
                <button
                  className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
                  onClick={() =>
                    void updateClipProperties(selectedClip.id, {
                      scaleY: clampScale(-(selectedClip.scaleY ?? 1)),
                    })
                  }
                  title="Flip vertical"
                >
                  ⇵
                </button>
                
                <button
                  className="rounded bg-emerald-700/70 px-2 py-1 text-xs text-white hover:bg-emerald-600"
                  onClick={fitToFrame}
                  title="Fit clip to frame"
                >
                  Fit
                </button>
                <button
                  className={`rounded px-2 py-1 text-[11px] ${
                    autoKeyframeEnabled
                      ? 'bg-emerald-700/80 text-white hover:bg-emerald-600'
                      : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                  }`}
                  onClick={() =>
                    useSelectionStore.getState().setAutoKeyframeEnabled(!autoKeyframeEnabled)
                  }
                  title="Auto-create keyframes while changing animated properties"
                >
                  {autoKeyframeEnabled ? 'AutoKey On' : 'AutoKey'}
                </button>
              </div>

              <SliderNumberField
                label="Position X"
                value={selectedClip.positionX ?? 0}
                min={-3000}
                max={3000}
                step={1}
                onChange={(v) => updateProp('positionX', v)}
                format={(v) => `${Math.round(v)} px`}
                sliderControls={renderInlineKeyframeControls('transform.positionX', 'Position X')}
              />
              <SliderNumberField
                label="Position Y"
                value={selectedClip.positionY ?? 0}
                min={-3000}
                max={3000}
                step={1}
                onChange={(v) => updateProp('positionY', v)}
                format={(v) => `${Math.round(v)} px`}
                sliderControls={renderInlineKeyframeControls('transform.positionY', 'Position Y')}
              />
              <div className="flex items-center justify-end gap-2 text-[11px] text-zinc-500">
                <span>Link W/H</span>
                <button
                  className={`rounded px-2 py-1 text-xs ${linkScale ? 'bg-blue-600/70 text-white' : 'bg-zinc-700 text-zinc-300'}`}
                  onClick={() => setLinkScale(!linkScale)}
                  title={linkScale ? 'Unlink width and height' : 'Link width and height'}
                >
                  {linkScale ? 'Linked' : 'Unlinked'}
                </button>
              </div>
              <SliderNumberField
                label="Width"
                value={widthPx}
                min={1}
                max={Math.max(8000, baseWidth * 4)}
                step={1}
                onChange={updateWidth}
                format={(v) => `${Math.round(v)} px`}
                sliderControls={renderInlineKeyframeControls('transform.scaleX', 'Width')}
              />
              <SliderNumberField
                label="Height"
                value={heightPx}
                min={1}
                max={Math.max(8000, baseHeight * 4)}
                step={1}
                onChange={updateHeight}
                format={(v) => `${Math.round(v)} px`}
                sliderControls={renderInlineKeyframeControls('transform.scaleY', 'Height')}
              />
              <SliderNumberField
                label="Rotation"
                value={selectedClip.rotation ?? 0}
                min={-180}
                max={180}
                step={1}
                onChange={(v) => updateProp('rotation', v)}
                format={(v) => `${Math.round(v)} deg`}
                sliderControls={renderInlineKeyframeControls('transform.rotation', 'Rotation')}
              />
              <SliderNumberField
                label="Opacity"
                value={(selectedClip.opacity ?? 1) * 100}
                min={0}
                max={100}
                step={1}
                onChange={(v) => updateProp('opacity', Math.max(0, Math.min(1, v / 100)))}
                format={(v) => `${Math.round(v)}%`}
                sliderControls={renderInlineKeyframeControls('opacity', 'Opacity')}
              />
            </CollapsibleSection>
          )}

          {isVisualClip && (
            <CollapsibleSection
              title="Speed"
              open={speedOpen}
              onToggle={() => setSpeedOpen((v) => !v)}
            >
              <div className="flex items-center gap-1">
                <button
                  className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
                  onClick={() => updateProp('speed', 1)}
                  title="Reset speed"
                >
                  Reset
                </button>
                <button
                  className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
                  onClick={() => updateProp('speed', -(selectedClip.speed ?? 1))}
                  title="Reverse clip direction"
                >
                  Reverse
                </button>
                <span className="rounded bg-zinc-700/60 px-2 py-1 text-[11px] text-zinc-200">
                  {speedLabel}
                </span>
                <button
                  className={`rounded px-2 py-1 text-[11px] ${
                    (selectedClip.preservePitch ?? true)
                      ? 'bg-blue-600/70 text-white'
                      : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                  }`}
                  onClick={() =>
                    updateClipProperties(selectedClip.id, {
                      preservePitch: !(selectedClip.preservePitch ?? true),
                    })
                  }
                  title="Preserve pitch while changing speed"
                >
                  Preserve Pitch
                </button>
              </div>
              <SliderNumberField
                label="Playback Speed"
                value={speedMagnitude}
                min={0.1}
                max={4}
                step={0.01}
                onChange={(v) => updateProp('speed', (speed < 0 ? -1 : 1) * v)}
                format={(v) => `${(v * 100).toFixed(0)}%`}
                sliderControls={renderInlineKeyframeControls('speed', 'Speed')}
              />
            </CollapsibleSection>
          )}

          {isVisualClip && (
            <CollapsibleSection
              title="Color"
              open={colorOpen}
              onToggle={() => setColorOpen((v) => !v)}
            >
              <div className="flex items-center gap-1">
                <button
                  className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
                  onClick={() =>
                    void updateClipProperties(selectedClip.id, {
                      brightness: 1,
                      contrast: 1,
                      saturation: 1,
                      hue: 0,
                      vignette: 0,
                    })
                  }
                  title="Reset color"
                >
                  Reset
                </button>
              </div>
              <SliderNumberField
                label="Brightness"
                value={(selectedClip.brightness ?? 1) * 100}
                min={0}
                max={200}
                step={1}
                onChange={(v) => updateProp('brightness', v / 100)}
                format={(v) => `${Math.round(v)}%`}
                sliderControls={renderInlineKeyframeControls('brightness', 'Brightness')}
              />
              <SliderNumberField
                label="Contrast"
                value={(selectedClip.contrast ?? 1) * 100}
                min={0}
                max={200}
                step={1}
                onChange={(v) => updateProp('contrast', v / 100)}
                format={(v) => `${Math.round(v)}%`}
                sliderControls={renderInlineKeyframeControls('contrast', 'Contrast')}
              />
              <SliderNumberField
                label="Saturation"
                value={(selectedClip.saturation ?? 1) * 100}
                min={0}
                max={200}
                step={1}
                onChange={(v) => updateProp('saturation', v / 100)}
                format={(v) => `${Math.round(v)}%`}
                sliderControls={renderInlineKeyframeControls('saturation', 'Saturation')}
              />
              <SliderNumberField
                label="Hue"
                value={selectedClip.hue ?? 0}
                min={-180}
                max={180}
                step={1}
                onChange={(v) => updateProp('hue', v)}
                format={(v) => `${Math.round(v)} deg`}
                sliderControls={renderInlineKeyframeControls('hue', 'Hue')}
              />
              <SliderNumberField
                label="Vignette"
                value={(selectedClip.vignette ?? 0) * 100}
                min={-100}
                max={100}
                step={1}
                onChange={(v) => updateProp('vignette', v / 100)}
                format={(v) =>
                  v === 0 ? 'None' : `${Math.round(Math.abs(v))}% ${v > 0 ? 'Dark' : 'Bright'}`
                }
                sliderControls={renderInlineKeyframeControls('vignette', 'Vignette')}
              />
            </CollapsibleSection>
          )}

          {isVisualClip && (
            <CollapsibleSection
              title="Compositing"
              open={compositingOpen}
              onToggle={() => setCompositingOpen((v) => !v)}
            >
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">Blend Mode</span>
                  <select
                    value={selectedClip.blendMode ?? 'normal'}
                    onChange={(e) =>
                      void updateClipProperties(selectedClip.id, {
                        blendMode: e.target.value as TimelineClipData['blendMode'],
                      })
                    }
                    className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200"
                  >
                    <option value="normal">Normal</option>
                    <option value="multiply">Multiply</option>
                    <option value="screen">Screen</option>
                    <option value="overlay">Overlay</option>
                    <option value="add">Add</option>
                    <option value="silhouette-alpha">Silhouette Alpha</option>
                    <option value="silhouette-luma">Silhouette Luma</option>
                  </select>
                </div>
                {(selectedClip.blendMode ?? 'normal') === 'silhouette-luma' && (
                  <SliderNumberField
                    label="Silhouette Gamma"
                    value={selectedClip.blendParams?.silhouetteGamma ?? 1}
                    min={0.1}
                    max={4}
                    step={0.01}
                    onChange={(v) =>
                      void updateClipProperties(selectedClip.id, {
                        blendParams: {
                          ...(selectedClip.blendParams ?? {}),
                          silhouetteGamma: v,
                        },
                      })
                    }
                    format={(v) => `${v.toFixed(2)}`}
                  />
                )}
              </div>
            </CollapsibleSection>
          )}

          {isVisualClip && (
            <CollapsibleSection
              title="Transitions"
              open={transitionsOpen}
              onToggle={() => setTransitionsOpen((v) => !v)}
            >
              <div className="space-y-3">
                {(['in', 'out'] as const).map((side) => {
                  const transition = side === 'in' ? selectedClip.transitionIn : selectedClip.transitionOut;
                  const limit = side === 'in' ? transitionLimitBySide.in : transitionLimitBySide.out;
                  const maxByLimit = Math.max(
                    1,
                    limit?.maxDurationFrames ?? Math.max(1, selectedClip.durationFrames),
                  );
                  const overLimit = transition ? transition.durationFrames > maxByLimit : false;
                  return (
                    <div key={side} className="rounded border border-zinc-700 bg-zinc-900/40 p-2">
                      <div className="mb-2 flex items-center justify-between text-[11px]">
                        <span className="text-zinc-500">{side === 'in' ? 'Transition In' : 'Transition Out'}</span>
                        <select
                          value={transition?.type ?? 'none'}
                          onChange={(e) =>
                            setTransitionType(
                              side,
                              e.target.value as 'none' | 'cross-dissolve' | 'fade-black',
                            )
                          }
                          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200"
                        >
                          <option value="none">None</option>
                          <option value="cross-dissolve">Cross Dissolve</option>
                          <option value="fade-black">Fade Black</option>
                        </select>
                      </div>
                      {transition && (
                        <>
                          <SliderNumberField
                            label="Duration (frames)"
                            value={transition.durationFrames}
                            min={1}
                            max={maxByLimit}
                            step={1}
                            onChange={(v) => updateTransitionDuration(side, v)}
                            format={(v) => `${Math.round(v)}f`}
                          />
                          <div className="mt-1 text-[10px] text-zinc-500">
                            Max by handles: {maxByLimit}f
                            {transition.type === 'cross-dissolve'
                              ? limit?.centeredOnCut
                                ? ' (centered on cut)'
                                : ' (no adjacent cut clip)'
                              : ''}
                          </div>
                          {overLimit && (
                            <div className="mt-1 text-[10px] text-amber-300">
                              Will be clamped to {maxByLimit}f on apply.
                            </div>
                          )}
                          {transition.type === 'cross-dissolve' && (
                            <label className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
                              <input
                                type="checkbox"
                                checked={transition.audioCrossfade ?? true}
                                onChange={(e) =>
                                  void setClipTransition(selectedClip.id, side, {
                                    ...transition,
                                    audioCrossfade: e.target.checked,
                                  })
                                }
                              />
                              Audio crossfade
                            </label>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </CollapsibleSection>
          )}

          {isVisualClip && (
            <CollapsibleSection
              title="Masks"
              open={masksOpen}
              onToggle={() => setMasksOpen((v) => !v)}
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                    {clipMasks.length === 0 && (
                      <div className="rounded border border-zinc-700 bg-zinc-900/40 px-2 py-1 text-[10px] text-zinc-500">
                        No masks
                      </div>
                    )}
                    {clipMasks.map((mask, index) => {
                      const isActive = selectedMask?.id === mask.id;
                      return (
                        <button
                          key={mask.id}
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] ${
                            isActive
                              ? 'border-cyan-400/70 bg-cyan-500/15 text-cyan-100'
                              : 'border-zinc-700 bg-zinc-900/40 text-zinc-300 hover:bg-zinc-800'
                          }`}
                          onClick={() => selectedClip && setActiveMaskSelection(selectedClip.id, mask.id)}
                          title={`Select ${mask.name}`}
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: MASK_CHIP_COLORS[index % MASK_CHIP_COLORS.length] ?? '#22d3ee' }}
                          />
                          <span className="truncate">{mask.name}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="rounded bg-blue-600/80 px-2 py-1 text-[11px] text-white hover:bg-blue-500"
                    onClick={addMask}
                  >
                    +Mask
                  </button>
                  <button
                    className="rounded bg-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-600 disabled:opacity-40"
                    onClick={removeSelectedMask}
                    disabled={!selectedMask}
                  >
                    Remove
                  </button>
                </div>

                {!selectedMask && (
                  <div className="rounded border border-zinc-700 bg-zinc-900/30 px-2 py-1 text-[11px] text-zinc-500">
                    Add a mask to start roto keyframing.
                  </div>
                )}

                {selectedMask && (
                  <>
                    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-[11px]">
                      <input
                        type="text"
                        value={selectedMask.name}
                        onChange={(e) => updateSelectedMask({ name: e.target.value })}
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200"
                        title="Mask name"
                      />
                      <select
                        value={selectedMask.mode}
                        onChange={(e) =>
                          updateSelectedMask({
                            mode: e.target.value as NonNullable<TimelineClipData['masks']>[number]['mode'],
                          })
                        }
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200"
                      >
                        <option value="add">Add</option>
                        <option value="subtract">Subtract</option>
                        <option value="intersect">Intersect</option>
                      </select>
                      <label className="flex items-center gap-1 text-zinc-400">
                        <input
                          type="checkbox"
                          checked={selectedMask.invert}
                          onChange={(e) => updateSelectedMask({ invert: e.target.checked })}
                        />
                        Invert
                      </label>
                    </div>

                    <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                      <input
                        type="checkbox"
                        checked={selectedMask.closed}
                        onChange={(e) => updateSelectedMask({ closed: e.target.checked })}
                      />
                      Closed shape
                    </label>

                    <SliderNumberField
                      label="Mask Opacity"
                      value={(selectedMask.opacity ?? 1) * 100}
                      min={0}
                      max={100}
                      step={1}
                      onChange={(v) => {
                        if (!selectedClip) return;
                        const next = clamp01(v / 100);
                        updateSelectedMask({ opacity: next });
                        const hasClockedKeyframes =
                          getClipPropertyKeyframes(selectedClip, 'mask.opacity').length > 0;
                        upsertPropertyKeyframeValue(
                          selectedClip,
                          'mask.opacity',
                          next,
                          hasClockedKeyframes,
                        );
                      }}
                      format={(v) => `${Math.round(v)}%`}
                      sliderControls={renderInlineKeyframeControls('mask.opacity', 'Mask Opacity')}
                    />
                    <SliderNumberField
                      label="Feather"
                      value={selectedMask.feather ?? 0}
                      min={0}
                      max={300}
                      step={1}
                      onChange={(v) => {
                        if (!selectedClip) return;
                        const next = Math.max(0, v);
                        updateSelectedMask({ feather: next });
                        const hasClockedKeyframes =
                          getClipPropertyKeyframes(selectedClip, 'mask.feather').length > 0;
                        upsertPropertyKeyframeValue(
                          selectedClip,
                          'mask.feather',
                          next,
                          hasClockedKeyframes,
                        );
                      }}
                      format={(v) => `${Math.round(v)} px`}
                      sliderControls={renderInlineKeyframeControls('mask.feather', 'Mask Feather')}
                    />
                    <SliderNumberField
                      label="Expansion"
                      value={selectedMask.expansion ?? 0}
                      min={-200}
                      max={200}
                      step={1}
                      onChange={(v) => {
                        if (!selectedClip) return;
                        updateSelectedMask({ expansion: v });
                        const hasClockedKeyframes =
                          getClipPropertyKeyframes(selectedClip, 'mask.expansion').length > 0;
                        upsertPropertyKeyframeValue(
                          selectedClip,
                          'mask.expansion',
                          v,
                          hasClockedKeyframes,
                        );
                      }}
                      format={(v) => `${Math.round(v)} px`}
                      sliderControls={renderInlineKeyframeControls('mask.expansion', 'Mask Expansion')}
                    />

                    <div className="rounded border border-zinc-700 bg-zinc-900/30 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                        <span>Mask Shape</span>
                        <span className="font-mono text-[10px] text-zinc-500">
                          {selectedMaskKeyframes.length} kf / {selectedMaskKeyframe?.points.length ?? 0} pts
                        </span>
                      </div>
                      <InlineKeyframeControls
                        active={selectedMaskKeyframes.length > 0}
                        label={`${selectedMask.name} shape`}
                        currentFrame={clipLocalFrame}
                        onToggle={() => {
                          if (!selectedClip) return;
                          if (selectedMaskKeyframes.length === 0) {
                            addMaskKeyframeAtPlayhead();
                            return;
                          }
                          const shouldClear = window.confirm(
                            `Delete all ${selectedMask.name} shape keyframes on this clip?`,
                          );
                          if (!shouldClear) return;
                          for (const keyframe of selectedMaskKeyframes) {
                            void removeMaskShapeKeyframe(selectedClip.id, selectedMask.id, keyframe.id);
                          }
                        }}
                        onPrev={() => jumpMaskKeyframe(-1)}
                        onAdd={addMaskKeyframeAtPlayhead}
                        onNext={() => jumpMaskKeyframe(1)}
                        onClear={() => {
                          if (!selectedClip || !selectedMaskKeyframe) return;
                          removeSelectedMaskKeyframe();
                        }}
                        disableNav={selectedMaskKeyframes.length === 0}
                        disableAdd={!selectedClip}
                        disableClear={!selectedMaskKeyframe}
                      />
                      <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1.5 text-[10px] text-zinc-500">
                        Shape, point type, position, scale and rotation are edited directly in Program.
                      </div>
                    </div>
                  </>
                )}
              </div>
            </CollapsibleSection>
          )}

          {audioControlClip && (
            <CollapsibleSection
              title="Audio"
              open={audioOpen}
              onToggle={() => setAudioOpen((v) => !v)}
            >
              <div className="flex items-center gap-1">
                <button
                  className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
                  onClick={() =>
                    updateClipProperties(audioControlClip.id, {
                      gain: 1,
                      pan: 0,
                      audioGainDb: 0,
                      audioVolume: 1,
                      audioPan: 0,
                      audioEqLow: 0,
                      audioEqMid: 0,
                      audioEqHigh: 0,
                      audioEq63: 0,
                      audioEq125: 0,
                      audioEq250: 0,
                      audioEq500: 0,
                      audioEq1k: 0,
                      audioEq2k: 0,
                      audioEq4k: 0,
                      audioEq8k: 0,
                    })
                  }
                >
                  Reset
                </button>
              </div>
              <SliderNumberField
                label="Volume"
                value={
                  audioControlClip.audioGainDb ??
                  gainToDb(audioControlClip.gain ?? audioControlClip.audioVolume ?? 1)
                }
                min={-60}
                max={12}
                step={0.5}
                onChange={(v) => {
                  const gain = Math.max(0, dbToGain(v));
                  void updateClipProperties(audioControlClip.id, {
                    audioGainDb: v,
                    gain,
                    audioVolume: gain,
                  });
                  const hasClockedKeyframes =
                    getClipPropertyKeyframes(audioControlClip, 'volume').length > 0;
                  upsertPropertyKeyframeValue(
                    audioControlClip,
                    'volume',
                    gain,
                    hasClockedKeyframes,
                  );
                }}
                format={(v) => (v <= -59.5 ? '-inf dB' : `${v.toFixed(1)} dB`)}
                sliderControls={renderInlineKeyframeControls('volume', 'Volume', audioControlClip)}
              />
              <SliderNumberField
                label="Pan"
                value={(audioControlClip.pan ?? audioControlClip.audioPan ?? 0) * 100}
                min={-100}
                max={100}
                step={1}
                onChange={(v) => {
                  const pan = v / 100;
                  void updateClipProperties(audioControlClip.id, { pan, audioPan: pan });
                  const hasClockedKeyframes =
                    getClipPropertyKeyframes(audioControlClip, 'pan').length > 0;
                  upsertPropertyKeyframeValue(audioControlClip, 'pan', pan, hasClockedKeyframes);
                }}
                format={(v) => `${Math.round(v)}%`}
                sliderControls={renderInlineKeyframeControls('pan', 'Pan', audioControlClip)}
              />
              <EqGraphic
                values={{
                  audioEq63: audioControlClip.audioEq63 ?? audioControlClip.audioEqLow ?? 0,
                  audioEq125: audioControlClip.audioEq125 ?? 0,
                  audioEq250: audioControlClip.audioEq250 ?? 0,
                  audioEq500: audioControlClip.audioEq500 ?? 0,
                  audioEq1k: audioControlClip.audioEq1k ?? audioControlClip.audioEqMid ?? 0,
                  audioEq2k: audioControlClip.audioEq2k ?? 0,
                  audioEq4k: audioControlClip.audioEq4k ?? 0,
                  audioEq8k: audioControlClip.audioEq8k ?? audioControlClip.audioEqHigh ?? 0,
                }}
                onChange={(key, value) =>
                  updateClipProperties(audioControlClip.id, { [key]: value })
                }
              />
            </CollapsibleSection>
          )}

          <StaticSection title="Timing">
            <Row label="Start" value={formatFrames(selectedClip.startFrame)} />
            <Row label="Duration" value={formatFrames(selectedClip.durationFrames)} />
            <Row
              label="End"
              value={formatFrames(selectedClip.startFrame + selectedClip.durationFrames)}
            />
          </StaticSection>

          {clipAsset && (
            <StaticSection title="Media">
              <Row label="File" value={clipAsset.name} />
              {clipAsset.resolution && (
                <Row
                  label="Resolution"
                  value={`${clipAsset.resolution.width}x${clipAsset.resolution.height}`}
                />
              )}
              {clipAsset.duration != null && (
                <Row label="Duration" value={`${clipAsset.duration.toFixed(2)}s`} />
              )}
            </StaticSection>
          )}
        </>
      ) : hasClipSelection ? (
        <div className="border-b border-zinc-700 px-3 py-3 text-xs text-zinc-400">
          {selectedClipIds.size} clips selected
        </div>
      ) : sourceAsset ? (
        <>
          <StaticSection title="Source">
            <Row label="Name" value={sourceAsset.name} />
            <Row label="Type" value={sourceAsset.type} />
            {sourceAsset.duration != null && (
              <Row label="Duration" value={`${sourceAsset.duration.toFixed(2)}s`} />
            )}
            {sourceAsset.resolution && (
              <Row
                label="Resolution"
                value={`${sourceAsset.resolution.width}x${sourceAsset.resolution.height}`}
              />
            )}
            {sourceAsset.fileSize != null && (
              <Row label="Size" value={formatSize(sourceAsset.fileSize)} />
            )}
          </StaticSection>
          {(sourceInTime != null || sourceOutTime != null) && (
            <StaticSection title="In / Out">
              {sourceInTime != null && <Row label="In" value={`${sourceInTime.toFixed(3)}s`} />}
              {sourceOutTime != null && <Row label="Out" value={`${sourceOutTime.toFixed(3)}s`} />}
            </StaticSection>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
          No selection
        </div>
      )}
    </aside>
  );
}
