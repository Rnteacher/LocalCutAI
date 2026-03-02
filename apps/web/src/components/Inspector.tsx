import { useSelectionStore } from '../stores/selectionStore.js';

/**
 * Inspector panel — shows properties of selected clip(s).
 * Transform (position, scale, rotation), opacity, audio levels.
 */

interface NumberFieldProps {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

function NumberField({ label, value, unit, min, max, step = 1, disabled = false }: NumberFieldProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="min-w-[72px] text-xs text-zinc-400">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          className="w-16 rounded border border-zinc-600 bg-zinc-900 px-1.5 py-0.5 text-right text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-40"
          readOnly
        />
        {unit && <span className="w-4 text-[10px] text-zinc-500">{unit}</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-zinc-700 px-3 py-2">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function Inspector() {
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const hasSelection = selectedClipIds.size > 0;

  return (
    <aside className="flex w-56 flex-col overflow-y-auto border-l border-zinc-700 bg-zinc-800/50 text-zinc-300">
      <div className="border-b border-zinc-700 px-3 py-2">
        <h2 className="text-xs font-semibold text-zinc-400">Inspector</h2>
      </div>

      {!hasSelection ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-xs text-zinc-600">No clip selected</span>
        </div>
      ) : (
        <>
          {/* Selection info */}
          <div className="border-b border-zinc-700 px-3 py-2">
            <span className="text-xs text-zinc-400">
              {selectedClipIds.size === 1
                ? '1 clip selected'
                : `${selectedClipIds.size} clips selected`}
            </span>
          </div>

          {/* Transform */}
          <Section title="Transform">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <NumberField label="X" value={0} unit="px" disabled={!hasSelection} />
              <NumberField label="Y" value={0} unit="px" disabled={!hasSelection} />
              <NumberField label="Scale X" value={100} unit="%" min={0} max={1000} disabled={!hasSelection} />
              <NumberField label="Scale Y" value={100} unit="%" min={0} max={1000} disabled={!hasSelection} />
            </div>
            <NumberField label="Rotation" value={0} unit="°" min={-360} max={360} disabled={!hasSelection} />
          </Section>

          {/* Opacity */}
          <Section title="Opacity">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={100}
                disabled={!hasSelection}
                className="h-1 flex-1 cursor-pointer appearance-none rounded-lg bg-zinc-700 disabled:opacity-40"
                readOnly
              />
              <span className="w-8 text-right text-xs text-zinc-300">100%</span>
            </div>
          </Section>

          {/* Audio */}
          <Section title="Audio">
            <div className="flex items-center gap-2">
              <label className="min-w-[72px] text-xs text-zinc-400">Volume</label>
              <input
                type="range"
                min={0}
                max={200}
                value={100}
                disabled={!hasSelection}
                className="h-1 flex-1 cursor-pointer appearance-none rounded-lg bg-zinc-700 disabled:opacity-40"
                readOnly
              />
              <span className="w-8 text-right text-xs text-zinc-300">0 dB</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="min-w-[72px] text-xs text-zinc-400">Pan</label>
              <input
                type="range"
                min={-100}
                max={100}
                value={0}
                disabled={!hasSelection}
                className="h-1 flex-1 cursor-pointer appearance-none rounded-lg bg-zinc-700 disabled:opacity-40"
                readOnly
              />
              <span className="w-8 text-right text-xs text-zinc-300">C</span>
            </div>
          </Section>

          {/* Blend Mode */}
          <Section title="Blend Mode">
            <select
              disabled={!hasSelection}
              className="w-full rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-blue-500 disabled:opacity-40"
              defaultValue="normal"
            >
              <option value="normal">Normal</option>
              <option value="multiply">Multiply</option>
              <option value="screen">Screen</option>
              <option value="overlay">Overlay</option>
              <option value="add">Add</option>
            </select>
          </Section>

          {/* Timing */}
          <Section title="Timing">
            <NumberField label="Start" value={0} unit="f" disabled={!hasSelection} />
            <NumberField label="Duration" value={0} unit="f" disabled={!hasSelection} />
            <NumberField label="In Point" value={0} unit="f" disabled={!hasSelection} />
            <NumberField label="Out Point" value={0} unit="f" disabled={!hasSelection} />
          </Section>
        </>
      )}
    </aside>
  );
}
