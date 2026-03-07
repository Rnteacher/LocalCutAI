import { useMemo, useState, useEffect } from 'react';
import { UIButton, UIInput, UISelect } from './ui.js';

interface ProjectSettingsValue {
  defaultFrameRate?: { num: number; den: number };
  defaultResolution?: { width: number; height: number };
  audioSampleRate?: number;
  aspectRatio?: string;
  audioChannels?: number;
}

export function ProjectSettingsDialog({
  open,
  title,
  initial,
  onCancel,
  onSave,
}: {
  open: boolean;
  title: string;
  initial: ProjectSettingsValue;
  onCancel: () => void;
  onSave: (settings: ProjectSettingsValue) => void;
}) {
  const [fps, setFps] = useState(initial.defaultFrameRate?.num ?? 24);
  const [resolution, setResolution] = useState(
    initial.defaultResolution
      ? `${initial.defaultResolution.width}x${initial.defaultResolution.height}`
      : '1920x1080',
  );
  const [sampleRate, setSampleRate] = useState(initial.audioSampleRate ?? 48000);
  const [audioChannels, setAudioChannels] = useState(initial.audioChannels ?? 2);

  useEffect(() => {
    if (!open) return;
    setFps(initial.defaultFrameRate?.num ?? 24);
    setResolution(
      initial.defaultResolution
        ? `${initial.defaultResolution.width}x${initial.defaultResolution.height}`
        : '1920x1080',
    );
    setSampleRate(initial.audioSampleRate ?? 48000);
    setAudioChannels(initial.audioChannels ?? 2);
  }, [open, initial]);

  const aspectRatio = useMemo(() => {
    const [w, h] = resolution.split('x').map(Number);
    if (!w || !h) return '16:9';
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const d = gcd(w, h);
    return `${w / d}:${h / d}`;
  }, [resolution]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="lc-panel w-[560px] max-w-[94vw] rounded-xl p-4 shadow-2xl">
        <h3 className="mb-3 text-sm font-semibold text-zinc-100">{title}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-zinc-400">
            <span>Frame Rate</span>
            <UISelect value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              <option value={23.976}>23.976</option>
              <option value={24}>24</option>
              <option value={25}>25</option>
              <option value={29.97}>29.97</option>
              <option value={30}>30</option>
              <option value={50}>50</option>
              <option value={60}>60</option>
            </UISelect>
          </label>

          <label className="space-y-1 text-xs text-zinc-400">
            <span>Resolution</span>
            <UISelect value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option value="1280x720">1280x720 (HD)</option>
              <option value="1920x1080">1920x1080 (Full HD)</option>
              <option value="2560x1440">2560x1440 (QHD)</option>
              <option value="3840x2160">3840x2160 (4K UHD)</option>
            </UISelect>
          </label>

          <label className="space-y-1 text-xs text-zinc-400">
            <span>Aspect Ratio</span>
            <UIInput readOnly value={aspectRatio} />
          </label>

          <label className="space-y-1 text-xs text-zinc-400">
            <span>Audio Sample Rate</span>
            <UISelect value={sampleRate} onChange={(e) => setSampleRate(Number(e.target.value))}>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
              <option value={96000}>96 kHz</option>
            </UISelect>
          </label>

          <label className="space-y-1 text-xs text-zinc-400 sm:col-span-2">
            <span>Audio Channels</span>
            <UISelect
              value={audioChannels}
              onChange={(e) => setAudioChannels(Number(e.target.value))}
            >
              <option value={1}>Mono</option>
              <option value={2}>Stereo</option>
            </UISelect>
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <UIButton onClick={onCancel}>Cancel</UIButton>
          <UIButton
            variant="primary"
            onClick={() => {
              const [width, height] = resolution.split('x').map(Number);
              const fpsNum = Number.isInteger(fps) ? fps : Math.round(fps * 1000);
              const fpsDen = Number.isInteger(fps) ? 1 : 1000;
              onSave({
                defaultFrameRate: { num: fpsNum, den: fpsDen },
                defaultResolution: { width, height },
                audioSampleRate: sampleRate,
                aspectRatio,
                audioChannels,
              });
            }}
          >
            Save
          </UIButton>
        </div>
      </div>
    </div>
  );
}
