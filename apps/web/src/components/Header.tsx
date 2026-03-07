import { useState } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { ExportDialog } from './ExportDialog.js';
import { ProjectSettingsDialog } from './ProjectSettingsDialog.js';
import { UIButton, UISelect } from './ui.js';

export function Header() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const sequences = useProjectStore((s) => s.sequences);
  const updateProjectSettings = useProjectStore((s) => s.updateProjectSettings);
  const [showExport, setShowExport] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);

  const firstSequenceId = sequences[0]?.id;
  const settings = (currentProject?.settings ?? {}) as {
    defaultFrameRate?: { num: number; den: number };
    defaultResolution?: { width: number; height: number };
    audioSampleRate?: number;
  };

  const fpsValue = settings.defaultFrameRate?.den
    ? Math.round(settings.defaultFrameRate.num / settings.defaultFrameRate.den)
    : 24;
  const resolutionValue = settings.defaultResolution
    ? `${settings.defaultResolution.width}x${settings.defaultResolution.height}`
    : '1920x1080';
  const sampleRateValue = settings.audioSampleRate ?? 48000;

  return (
    <>
      <header className="flex h-11 items-center border-b border-zinc-800 bg-zinc-900/95 px-4">
        <h1 className="text-sm font-semibold tracking-[0.14em] text-cyan-300">LOCALCUT</h1>
        <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
          v0.1.0
        </span>
        {currentProject && (
          <>
            <span className="mx-3 text-zinc-700">/</span>
            <span className="max-w-72 truncate text-sm text-zinc-300">{currentProject.name}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {currentProject && (
            <>
              <UISelect
                value={fpsValue}
                onChange={(e) => {
                  const fps = Number(e.target.value);
                  void updateProjectSettings({ defaultFrameRate: { num: fps, den: 1 } });
                }}
                className="lc-select max-w-[86px]"
                title="Project FPS"
              >
                <option value={24}>24fps</option>
                <option value={25}>25fps</option>
                <option value={30}>30fps</option>
                <option value={60}>60fps</option>
              </UISelect>

              <UISelect
                value={resolutionValue}
                onChange={(e) => {
                  const [width, height] = e.target.value.split('x').map(Number);
                  void updateProjectSettings({ defaultResolution: { width, height } });
                }}
                className="lc-select max-w-[120px]"
                title="Project resolution"
              >
                <option value="1280x720">1280x720</option>
                <option value="1920x1080">1920x1080</option>
              </UISelect>

              <UISelect
                value={sampleRateValue}
                onChange={(e) => {
                  const sampleRate = Number(e.target.value);
                  void updateProjectSettings({ audioSampleRate: sampleRate });
                }}
                className="lc-select max-w-[92px]"
                title="Audio sample rate"
              >
                <option value={44100}>44.1kHz</option>
                <option value={48000}>48kHz</option>
              </UISelect>
            </>
          )}

          {currentProject && firstSequenceId && (
            <UIButton variant="primary" onClick={() => setShowExport(true)}>
              Export
            </UIButton>
          )}
          {currentProject && (
            <UIButton onClick={() => setShowProjectSettings(true)}>Settings</UIButton>
          )}
          {currentProject && (
            <span className="max-w-64 truncate text-xs text-zinc-600">
              {currentProject.projectDir}
            </span>
          )}
        </div>
      </header>

      {showExport && firstSequenceId && (
        <ExportDialog sequenceId={firstSequenceId} onClose={() => setShowExport(false)} />
      )}

      {currentProject && (
        <ProjectSettingsDialog
          open={showProjectSettings}
          title="Project Settings"
          initial={{
            defaultFrameRate: settings.defaultFrameRate ?? { num: fpsValue, den: 1 },
            defaultResolution: settings.defaultResolution ?? { width: 1920, height: 1080 },
            audioSampleRate: sampleRateValue,
            aspectRatio: '16:9',
            audioChannels: 2,
          }}
          onCancel={() => setShowProjectSettings(false)}
          onSave={(next) => {
            void updateProjectSettings(next);
            setShowProjectSettings(false);
          }}
        />
      )}
    </>
  );
}
