import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSelectionStore } from '../stores/selectionStore.js';
import { useProjectStore, computeTransitionSideLimit } from '../stores/projectStore.js';
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

const KEYFRAME_PROPERTIES: Array<{
  value: NonNullable<TimelineClipData['keyframes']>[number]['property'];
  label: string;
}> = [
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

type KeyframeProperty = NonNullable<TimelineClipData['keyframes']>[number]['property'];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function keyframeValueBounds(property: KeyframeProperty, values: number[]): { min: number; max: number } {
  let min = -1;
  let max = 1;
  switch (property) {
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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
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
        className="w-full accent-blue-500"
      />
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

function KeyframeMiniGraph({
  keyframes,
  clipDuration,
  property,
  currentFrame,
  onCommit,
}: {
  keyframes: NonNullable<TimelineClipData['keyframes']>;
  clipDuration: number;
  property: KeyframeProperty;
  currentFrame: number;
  onCommit: (keyframeId: string, frame: number, value: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draftById, setDraftById] = useState<Record<string, { frame: number; value: number }>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    setDraftById({});
  }, [property]);

  const sorted = useMemo(() => [...keyframes].sort((a, b) => a.frame - b.frame), [keyframes]);
  const effective = useMemo(
    () =>
      sorted.map((kf) => {
        const draft = draftById[kf.id];
        if (!draft) return kf;
        return { ...kf, frame: draft.frame, value: draft.value };
      }),
    [sorted, draftById],
  );

  if (!effective.length) {
    return <div className="text-[10px] text-zinc-500">No keyframes</div>;
  }

  const bounds = keyframeValueBounds(
    property,
    effective.map((k) => k.value),
  );
  const span = Math.max(0.0001, bounds.max - bounds.min);
  const points = effective
    .map((k) => {
      const x = ((Math.max(0, k.frame) / Math.max(1, clipDuration)) * 100).toFixed(2);
      const y = (100 - (((k.value - bounds.min) / span) * 100)).toFixed(2);
      return `${x},${y}`;
    })
    .join(' ');
  const currentX = (Math.max(0, Math.min(clipDuration, currentFrame)) / Math.max(1, clipDuration)) * 100;

  const updateFromPointer = useCallback(
    (keyframeId: string, clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const nx = clamp01((clientX - rect.left) / Math.max(1, rect.width));
      const ny = clamp01((clientY - rect.top) / Math.max(1, rect.height));
      const frame = Math.max(0, Math.round(nx * clipDuration));
      const value = bounds.min + (1 - ny) * (bounds.max - bounds.min);
      setDraftById((prev) => ({ ...prev, [keyframeId]: { frame, value } }));
    },
    [bounds.max, bounds.min, clipDuration],
  );

  useEffect(() => {
    if (!draggingId) return;
    const onMove = (e: MouseEvent) => {
      updateFromPointer(draggingId, e.clientX, e.clientY);
    };
    const onUp = () => {
      const draft = draftById[draggingId];
      if (draft) {
        onCommit(draggingId, draft.frame, draft.value);
      }
      setDraggingId(null);
      setDraftById((prev) => {
        const next = { ...prev };
        delete next[draggingId];
        return next;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingId, draftById, onCommit, updateFromPointer]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      className="h-24 w-full rounded border border-zinc-700 bg-zinc-900/50"
    >
      <line x1={currentX} y1={0} x2={currentX} y2={100} stroke="#334155" strokeWidth="0.8" />
      <polyline fill="none" stroke="#60a5fa" strokeWidth="1.6" points={points} />
      {effective.map((k) => {
        const x = (Math.max(0, k.frame) / Math.max(1, clipDuration)) * 100;
        const y = 100 - ((k.value - bounds.min) / span) * 100;
        return (
          <circle
            key={k.id}
            cx={x}
            cy={y}
            r="2.6"
            fill={draggingId === k.id ? '#bfdbfe' : '#93c5fd'}
            className="cursor-pointer"
            onMouseDown={(e) => {
              e.preventDefault();
              setDraggingId(k.id);
              updateFromPointer(k.id, e.clientX, e.clientY);
            }}
          />
        );
      })}
    </svg>
  );
}

export function Inspector({ onToggleCollapse }: { onToggleCollapse?: () => void }) {
  const setActivePanel = useSelectionStore((s) => s.setActivePanel);
  const activePanel = useSelectionStore((s) => s.activePanel);
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
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
  const [keyframesOpen, setKeyframesOpen] = useState(false);
  const [masksOpen, setMasksOpen] = useState(false);
  const [linkScale, setLinkScale] = useState(true);
  const [kfProperty, setKfProperty] = useState<KeyframeProperty>('transform.positionX');
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);
  const [selectedMaskKeyframeId, setSelectedMaskKeyframeId] = useState<string | null>(null);
  const [selectedMaskPointIndex, setSelectedMaskPointIndex] = useState(0);

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

  const updateProp = useCallback(
    (key: keyof TimelineClipData, value: number) => {
      if (!selectedClip) return;
      void updateClipProperties(selectedClip.id, { [key]: value });
    },
    [selectedClip, updateClipProperties],
  );

  const updateScaleX = useCallback(
    (v: number) => {
      if (!selectedClip) return;
      const next = clampScale(v);
      if (linkScale) {
        const sySign = (selectedClip.scaleY ?? 1) < 0 ? -1 : 1;
        void updateClipProperties(selectedClip.id, {
          scaleX: next,
          scaleY: clampScale(Math.abs(next) * sySign),
        });
      } else {
        void updateClipProperties(selectedClip.id, { scaleX: next });
      }
    },
    [selectedClip, linkScale, updateClipProperties],
  );

  const updateScaleY = useCallback(
    (v: number) => {
      if (!selectedClip) return;
      const next = clampScale(v);
      if (linkScale) {
        const sxSign = (selectedClip.scaleX ?? 1) < 0 ? -1 : 1;
        void updateClipProperties(selectedClip.id, {
          scaleX: clampScale(Math.abs(next) * sxSign),
          scaleY: next,
        });
      } else {
        void updateClipProperties(selectedClip.id, { scaleY: next });
      }
    },
    [selectedClip, linkScale, updateClipProperties],
  );

  const fitToFrame = useCallback(() => {
    if (!selectedClip || !clipAsset) return;
    const srcW = clipAsset.resolution?.width ?? seqResolution.width;
    const srcH = clipAsset.resolution?.height ?? seqResolution.height;
    const fitX = seqResolution.width / Math.max(1, srcW);
    const fitY = seqResolution.height / Math.max(1, srcH);
    const sxSign = (selectedClip.scaleX ?? 1) < 0 ? -1 : 1;
    const sySign = (selectedClip.scaleY ?? 1) < 0 ? -1 : 1;
    void updateClipProperties(selectedClip.id, {
      scaleX: clampScale(fitX * sxSign),
      scaleY: clampScale(fitY * sySign),
      positionX: 0,
      positionY: 0,
    });
  }, [selectedClip, clipAsset, seqResolution.width, seqResolution.height, updateClipProperties]);

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

  const selectedPropertyKeyframes = useMemo(() => {
    if (!selectedClip?.keyframes) return [];
    return selectedClip.keyframes
      .filter((kf) => kf.property === kfProperty)
      .sort((a, b) => a.frame - b.frame);
  }, [selectedClip?.keyframes, kfProperty]);

  const clipMasks = useMemo(() => selectedClip?.masks ?? [], [selectedClip?.masks]);
  const selectedMask = useMemo(
    () => clipMasks.find((m) => m.id === selectedMaskId) ?? clipMasks[0] ?? null,
    [clipMasks, selectedMaskId],
  );

  useEffect(() => {
    if (!selectedMask) {
      setSelectedMaskId(null);
      return;
    }
    if (selectedMaskId !== selectedMask.id) {
      setSelectedMaskId(selectedMask.id);
    }
  }, [selectedMask, selectedMaskId]);

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

  useEffect(() => {
    if (!selectedMaskKeyframe || selectedMaskKeyframe.points.length === 0) {
      setSelectedMaskPointIndex(0);
      return;
    }
    if (selectedMaskPointIndex >= selectedMaskKeyframe.points.length) {
      setSelectedMaskPointIndex(Math.max(0, selectedMaskKeyframe.points.length - 1));
    }
  }, [selectedMaskKeyframe, selectedMaskPointIndex]);

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

  const getPropertyValueAtCurrent = useCallback((): number => {
    if (!selectedClip) return 0;
    switch (kfProperty) {
      case 'transform.positionX':
        return selectedClip.positionX ?? 0;
      case 'transform.positionY':
        return selectedClip.positionY ?? 0;
      case 'transform.scaleX':
        return selectedClip.scaleX ?? 1;
      case 'transform.scaleY':
        return selectedClip.scaleY ?? 1;
      case 'transform.rotation':
        return selectedClip.rotation ?? 0;
      case 'transform.anchorX':
      case 'transform.anchorY':
        return 0.5;
      case 'opacity':
        return selectedClip.opacity ?? 1;
      case 'mask.opacity':
        return selectedMask?.opacity ?? 1;
      case 'mask.feather':
        return selectedMask?.feather ?? 0;
      case 'mask.expansion':
        return selectedMask?.expansion ?? 0;
      default:
        return 0;
    }
  }, [selectedClip, kfProperty, selectedMask?.opacity, selectedMask?.feather, selectedMask?.expansion]);

  const addKeyframeAtPlayhead = useCallback(() => {
    if (!selectedClip) return;
    const frame = clipLocalFrame;
    void upsertClipKeyframe(selectedClip.id, {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      property: kfProperty,
      frame,
      value: getPropertyValueAtCurrent(),
      easing: 'linear',
    });
  }, [selectedClip, clipLocalFrame, kfProperty, getPropertyValueAtCurrent, upsertClipKeyframe]);

  const updateSelectedKeyframe = useCallback(
    (
      keyframeId: string,
      patch: Partial<Pick<NonNullable<TimelineClipData['keyframes']>[number], 'frame' | 'value' | 'easing'>>,
    ) => {
      if (!selectedClip) return;
      const existing = selectedPropertyKeyframes.find((kf) => kf.id === keyframeId);
      if (!existing) return;
      void upsertClipKeyframe(selectedClip.id, {
        ...existing,
        frame: patch.frame != null ? Math.max(0, Math.round(patch.frame)) : existing.frame,
        value: patch.value ?? existing.value,
        easing: patch.easing ?? existing.easing,
      });
    },
    [selectedClip, selectedPropertyKeyframes, upsertClipKeyframe],
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
    setSelectedMaskId(id);
    setSelectedMaskKeyframeId(keyframeId);
    setSelectedMaskPointIndex(0);
  }, [selectedClip, clipMasks.length, clipLocalFrame, defaultMaskPoints, addClipMask]);

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

  const selectedMaskPoint = selectedMaskKeyframe?.points[selectedMaskPointIndex] ?? null;

  const updateMaskPoint = useCallback(
    (pointIndex: number, patch: Partial<MaskPoint>) => {
      if (!selectedMaskKeyframe) return;
      const points = cloneMaskPoints(selectedMaskKeyframe.points);
      const current = points[pointIndex];
      if (!current) return;
      points[pointIndex] = {
        x: patch.x ?? current.x,
        y: patch.y ?? current.y,
        inX: patch.inX ?? patch.x ?? current.inX,
        inY: patch.inY ?? patch.y ?? current.inY,
        outX: patch.outX ?? patch.x ?? current.outX,
        outY: patch.outY ?? patch.y ?? current.outY,
      };
      upsertSelectedMaskKeyframe({
        ...selectedMaskKeyframe,
        points,
      });
    },
    [selectedMaskKeyframe, cloneMaskPoints, upsertSelectedMaskKeyframe],
  );

  const addMaskPoint = useCallback(() => {
    if (!selectedMaskKeyframe) {
      addMaskKeyframeAtPlayhead();
      return;
    }
    const points = cloneMaskPoints(selectedMaskKeyframe.points);
    if (points.length === 0) {
      const defaults = defaultMaskPoints();
      upsertSelectedMaskKeyframe({
        ...selectedMaskKeyframe,
        points: defaults,
      });
      setSelectedMaskPointIndex(0);
      return;
    }
    const idx = Math.max(0, Math.min(points.length - 1, selectedMaskPointIndex));
    const nextIdx = (idx + 1) % points.length;
    const a = points[idx];
    const b = points[nextIdx];
    const mid: MaskPoint = {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      inX: (a.x + b.x) / 2,
      inY: (a.y + b.y) / 2,
      outX: (a.x + b.x) / 2,
      outY: (a.y + b.y) / 2,
    };
    points.splice(nextIdx, 0, mid);
    upsertSelectedMaskKeyframe({ ...selectedMaskKeyframe, points });
    setSelectedMaskPointIndex(nextIdx);
  }, [
    selectedMaskKeyframe,
    selectedMaskPointIndex,
    cloneMaskPoints,
    upsertSelectedMaskKeyframe,
    defaultMaskPoints,
    addMaskKeyframeAtPlayhead,
  ]);

  const removeMaskPoint = useCallback(() => {
    if (!selectedMaskKeyframe) return;
    if (selectedMaskKeyframe.points.length <= 2) return;
    const points = cloneMaskPoints(selectedMaskKeyframe.points);
    points.splice(selectedMaskPointIndex, 1);
    upsertSelectedMaskKeyframe({ ...selectedMaskKeyframe, points });
    setSelectedMaskPointIndex((idx) => Math.max(0, Math.min(idx, points.length - 1)));
  }, [selectedMaskKeyframe, selectedMaskPointIndex, cloneMaskPoints, upsertSelectedMaskKeyframe]);

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
                  ⤢
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
              />
              <SliderNumberField
                label="Position Y"
                value={selectedClip.positionY ?? 0}
                min={-3000}
                max={3000}
                step={1}
                onChange={(v) => updateProp('positionY', v)}
                format={(v) => `${Math.round(v)} px`}
              />
              <div className="flex items-center justify-end gap-2 text-[11px] text-zinc-500">
                <span>Link W/H</span>
                <button
                  className={`rounded px-2 py-1 text-xs ${linkScale ? 'bg-blue-600/70 text-white' : 'bg-zinc-700 text-zinc-300'}`}
                  onClick={() => setLinkScale((v) => !v)}
                  title={linkScale ? 'Unlink width and height' : 'Link width and height'}
                >
                  {linkScale ? '🔗' : '⛓'}
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
              />
              <SliderNumberField
                label="Height"
                value={heightPx}
                min={1}
                max={Math.max(8000, baseHeight * 4)}
                step={1}
                onChange={updateHeight}
                format={(v) => `${Math.round(v)} px`}
              />
              <SliderNumberField
                label="Rotation"
                value={selectedClip.rotation ?? 0}
                min={-180}
                max={180}
                step={1}
                onChange={(v) => updateProp('rotation', v)}
                format={(v) => `${Math.round(v)} deg`}
              />
              <SliderNumberField
                label="Opacity"
                value={(selectedClip.opacity ?? 1) * 100}
                min={0}
                max={100}
                step={1}
                onChange={(v) => updateProp('opacity', Math.max(0, Math.min(1, v / 100)))}
                format={(v) => `${Math.round(v)}%`}
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
                  ↺
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
                  ♪ Preserve Pitch
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
              />
              <SliderNumberField
                label="Contrast"
                value={(selectedClip.contrast ?? 1) * 100}
                min={0}
                max={200}
                step={1}
                onChange={(v) => updateProp('contrast', v / 100)}
                format={(v) => `${Math.round(v)}%`}
              />
              <SliderNumberField
                label="Saturation"
                value={(selectedClip.saturation ?? 1) * 100}
                min={0}
                max={200}
                step={1}
                onChange={(v) => updateProp('saturation', v / 100)}
                format={(v) => `${Math.round(v)}%`}
              />
              <SliderNumberField
                label="Hue"
                value={selectedClip.hue ?? 0}
                min={-180}
                max={180}
                step={1}
                onChange={(v) => updateProp('hue', v)}
                format={(v) => `${Math.round(v)} deg`}
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
              title="Keyframes"
              open={keyframesOpen}
              onToggle={() => setKeyframesOpen((v) => !v)}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <select
                    value={kfProperty}
                    onChange={(e) =>
                      setKfProperty(e.target.value as KeyframeProperty)
                    }
                    className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200"
                  >
                    {KEYFRAME_PROPERTIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="rounded bg-blue-600/80 px-2 py-1 text-[11px] text-white hover:bg-blue-500"
                    onClick={addKeyframeAtPlayhead}
                    title="Add/update keyframe at current playhead"
                  >
                    Add @ {clipLocalFrame}f
                  </button>
                </div>

                <KeyframeMiniGraph
                  keyframes={selectedPropertyKeyframes}
                  clipDuration={Math.max(1, selectedClip.durationFrames)}
                  property={kfProperty}
                  currentFrame={clipLocalFrame}
                  onCommit={(keyframeId, frame, value) =>
                    updateSelectedKeyframe(keyframeId, { frame, value })
                  }
                />

                <div className="max-h-36 space-y-1 overflow-y-auto rounded border border-zinc-700 bg-zinc-900/40 p-1">
                  {selectedPropertyKeyframes.length === 0 && (
                    <div className="px-1 py-0.5 text-[10px] text-zinc-500">No keyframes yet</div>
                  )}
                  {selectedPropertyKeyframes.map((kf) => (
                    <div key={kf.id} className="grid grid-cols-[62px_1fr_92px_52px] items-center gap-1 text-[11px]">
                      <input
                        type="number"
                        value={kf.frame}
                        min={0}
                        step={1}
                        onChange={(e) => {
                          const next = Number(e.target.value);
                          if (!Number.isFinite(next)) return;
                          updateSelectedKeyframe(kf.id, { frame: next });
                        }}
                        className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 font-mono text-zinc-300"
                        title="Frame"
                      />
                      <input
                        type="number"
                        value={Number.isFinite(kf.value) ? kf.value : 0}
                        step={0.01}
                        onChange={(e) => {
                          const next = Number(e.target.value);
                          if (!Number.isFinite(next)) return;
                          updateSelectedKeyframe(kf.id, { value: next });
                        }}
                        className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 font-mono text-zinc-300"
                        title="Value"
                      />
                      <select
                        value={kf.easing}
                        onChange={(e) =>
                          updateSelectedKeyframe(kf.id, {
                            easing: e.target.value as NonNullable<TimelineClipData['keyframes']>[number]['easing'],
                          })
                        }
                        className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-zinc-300"
                        title="Easing"
                      >
                        <option value="linear">Linear</option>
                        <option value="ease-in">Ease In</option>
                        <option value="ease-out">Ease Out</option>
                        <option value="ease-in-out">Ease In/Out</option>
                        <option value="bezier">Bezier</option>
                      </select>
                      <button
                        className="rounded px-1 text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-red-300"
                        onClick={() => void removeClipKeyframe(selectedClip.id, kf.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
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
                  <select
                    value={selectedMask?.id ?? ''}
                    onChange={(e) => setSelectedMaskId(e.target.value || null)}
                    className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200"
                  >
                    {clipMasks.length === 0 && <option value="">No masks</option>}
                    {clipMasks.map((mask) => (
                      <option key={mask.id} value={mask.id}>
                        {mask.name}
                      </option>
                    ))}
                  </select>
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
                      onChange={(v) => updateSelectedMask({ opacity: clamp01(v / 100) })}
                      format={(v) => `${Math.round(v)}%`}
                    />
                    <SliderNumberField
                      label="Feather"
                      value={selectedMask.feather ?? 0}
                      min={0}
                      max={300}
                      step={1}
                      onChange={(v) => updateSelectedMask({ feather: Math.max(0, v) })}
                      format={(v) => `${Math.round(v)} px`}
                    />
                    <SliderNumberField
                      label="Expansion"
                      value={selectedMask.expansion ?? 0}
                      min={-200}
                      max={200}
                      step={1}
                      onChange={(v) => updateSelectedMask({ expansion: v })}
                      format={(v) => `${Math.round(v)} px`}
                    />

                    <div className="rounded border border-zinc-700 bg-zinc-900/30 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                        <span>Shape Keyframes</span>
                        <div className="flex items-center gap-1">
                          <button
                            className="rounded bg-zinc-700 px-1.5 py-0.5 hover:bg-zinc-600"
                            onClick={() => jumpMaskKeyframe(-1)}
                            title="Previous keyframe"
                          >
                            Prev
                          </button>
                          <button
                            className="rounded bg-blue-600/80 px-1.5 py-0.5 text-white hover:bg-blue-500"
                            onClick={addMaskKeyframeAtPlayhead}
                            title="Add or update keyframe at playhead"
                          >
                            Add @{clipLocalFrame}f
                          </button>
                          <button
                            className="rounded bg-zinc-700 px-1.5 py-0.5 hover:bg-zinc-600 disabled:opacity-40"
                            disabled={!selectedMaskKeyframe}
                            onClick={removeSelectedMaskKeyframe}
                            title="Remove selected keyframe"
                          >
                            Del
                          </button>
                          <button
                            className="rounded bg-zinc-700 px-1.5 py-0.5 hover:bg-zinc-600"
                            onClick={() => jumpMaskKeyframe(1)}
                            title="Next keyframe"
                          >
                            Next
                          </button>
                        </div>
                      </div>

                      <select
                        value={selectedMaskKeyframe?.id ?? ''}
                        onChange={(e) => setSelectedMaskKeyframeId(e.target.value || null)}
                        className="mb-2 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200"
                      >
                        {selectedMaskKeyframes.length === 0 && <option value="">No keyframes</option>}
                        {selectedMaskKeyframes.map((kf) => (
                          <option key={kf.id} value={kf.id}>
                            {kf.frame}f ({kf.points.length} pts)
                          </option>
                        ))}
                      </select>

                      {selectedMaskKeyframe && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <select
                              value={selectedMaskPointIndex}
                              onChange={(e) => setSelectedMaskPointIndex(Number(e.target.value))}
                              className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200"
                            >
                              {selectedMaskKeyframe.points.map((_, idx) => (
                                <option key={idx} value={idx}>
                                  Point {idx + 1}
                                </option>
                              ))}
                            </select>
                            <button
                              className="rounded bg-zinc-700 px-2 py-1 text-[11px] hover:bg-zinc-600"
                              onClick={addMaskPoint}
                            >
                              +Pt
                            </button>
                            <button
                              className="rounded bg-zinc-700 px-2 py-1 text-[11px] hover:bg-zinc-600 disabled:opacity-40"
                              disabled={selectedMaskKeyframe.points.length <= 2}
                              onClick={removeMaskPoint}
                            >
                              -Pt
                            </button>
                          </div>

                          {selectedMaskPoint && (
                            <div className="grid grid-cols-2 gap-2">
                              <SliderNumberField
                                label="Point X"
                                value={selectedMaskPoint.x}
                                min={-baseWidth}
                                max={baseWidth * 2}
                                step={1}
                                onChange={(v) => updateMaskPoint(selectedMaskPointIndex, { x: v })}
                                format={(v) => `${Math.round(v)} px`}
                              />
                              <SliderNumberField
                                label="Point Y"
                                value={selectedMaskPoint.y}
                                min={-baseHeight}
                                max={baseHeight * 2}
                                step={1}
                                onChange={(v) => updateMaskPoint(selectedMaskPointIndex, { y: v })}
                                format={(v) => `${Math.round(v)} px`}
                              />
                            </div>
                          )}
                        </div>
                      )}
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
                onChange={(v) =>
                  updateClipProperties(audioControlClip.id, {
                    audioGainDb: v,
                    gain: Math.max(0, dbToGain(v)),
                    audioVolume: Math.max(0, dbToGain(v)),
                  })
                }
                format={(v) => (v <= -59.5 ? '-inf dB' : `${v.toFixed(1)} dB`)}
              />
              <SliderNumberField
                label="Pan"
                value={(audioControlClip.pan ?? audioControlClip.audioPan ?? 0) * 100}
                min={-100}
                max={100}
                step={1}
                onChange={(v) =>
                  updateClipProperties(audioControlClip.id, { pan: v / 100, audioPan: v / 100 })
                }
                format={(v) => `${Math.round(v)}%`}
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
