import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSelectionStore } from '../stores/selectionStore.js';
import { useProjectStore } from '../stores/projectStore.js';
import type { TimelineClipData, TimelineTrackData } from '../stores/projectStore.js';

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

  const [transformOpen, setTransformOpen] = useState(true);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [linkScale, setLinkScale] = useState(true);

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
