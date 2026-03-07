import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { on as onWs } from '../lib/ws.js';
import type { ApiExportPreset, ExportStartParams } from '../lib/api.js';
import { useProjectStore } from '../stores/projectStore.js';

interface ExportDialogProps {
  sequenceId: string;
  onClose: () => void;
}

export function ExportDialog({ sequenceId, onClose }: ExportDialogProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const [presets, setPresets] = useState<ApiExportPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('H.264 High Quality');
  const [filename, setFilename] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);

  // Load presets
  useEffect(() => {
    api.export.presets().then(setPresets).catch(() => {
      // Use fallback presets
      setPresets([
        { name: 'H.264 High Quality', format: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', crf: 18, preset: 'medium', audioBitrate: '192k', audioSampleRate: 48000 },
        { name: 'H.264 Fast (Draft)', format: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', crf: 23, preset: 'veryfast', audioBitrate: '128k', audioSampleRate: 48000 },
      ]);
    });
  }, []);

  // Generate default filename
  useEffect(() => {
    const preset = presets.find((p) => p.name === selectedPreset);
    const ext = preset?.format || 'mp4';
    const ts = new Date().toISOString().slice(0, 10);
    setFilename(`export-${ts}.${ext}`);
  }, [selectedPreset, presets]);

    // Listen for WebSocket progress updates
  useEffect(() => {
    if (!jobId) return;

    const unsubscribe = onWs('job:progress', (data) => {
      if (data?.jobId !== jobId) return;

      const nextProgress = typeof data.progress === 'number' ? data.progress : 0;
      const nextStatus = typeof data.status === 'string' ? data.status : '';
      setProgress(nextProgress);
      setStatus(nextStatus);

      if (nextStatus === 'completed') {
        setIsExporting(false);
      }
      if (nextStatus === 'failed') {
        setIsExporting(false);
        setError('Export failed. Check the server logs for details.');
      }
      if (nextStatus === 'cancelled') {
        setIsExporting(false);
      }
    });

    // Poll as fallback in case WS disconnects or message is missed.
    const interval = setInterval(async () => {
      try {
        const job = await api.jobs.get(jobId);
        setProgress(job.progress);
        setStatus(job.status);
        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
          setIsExporting(false);
          if (job.status === 'failed') {
            setError(job.error || 'Export failed');
          }
          clearInterval(interval);
        }
      } catch {
        // Ignore errors
      }
    }, 2000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [jobId]);

  const handleExport = useCallback(async () => {
    const preset = presets.find((p) => p.name === selectedPreset);
    if (!preset) return;

    setIsExporting(true);
    setError(null);
    setProgress(0);
    setStatus('queued');

    try {
      const params: ExportStartParams = {
        sequenceId,
        filename: filename || undefined,
        format: preset.format as ExportStartParams['format'],
        videoCodec: preset.videoCodec as ExportStartParams['videoCodec'],
        audioCodec: preset.audioCodec as ExportStartParams['audioCodec'],
        crf: preset.crf,
        preset: preset.preset,
        audioBitrate: preset.audioBitrate,
        audioSampleRate: preset.audioSampleRate,
      };

      const job = await api.export.start(params);
      setJobId(job.id);
      setOutputPath(job.outputPath);
    } catch (err) {
      setIsExporting(false);
      setError(err instanceof Error ? err.message : 'Failed to start export');
    }
  }, [sequenceId, filename, selectedPreset, presets]);

  const handleCancel = useCallback(async () => {
    if (jobId) {
      await api.export.cancel(jobId).catch(() => {});
      setIsExporting(false);
      setStatus('cancelled');
    }
  }, [jobId]);

  const progressPercent = Math.round(progress * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[480px] rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">Export Sequence</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
            disabled={isExporting}
          >
            x
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-4 py-4">
          {/* Preset selector */}
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Preset</label>
            <select
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              disabled={isExporting}
              className="w-full rounded border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-blue-500"
            >
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Preset details */}
          {(() => {
            const preset = presets.find((p) => p.name === selectedPreset);
            if (!preset) return null;
            return (
              <div className="rounded border border-zinc-700 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-400">
                <div className="flex gap-4">
                  <span>Format: <span className="text-zinc-300">{preset.format.toUpperCase()}</span></span>
                  <span>Video: <span className="text-zinc-300">{preset.videoCodec}</span></span>
                  <span>Audio: <span className="text-zinc-300">{preset.audioCodec}</span></span>
                </div>
                {preset.crf !== undefined && (
                  <div className="mt-1 flex gap-4">
                    <span>CRF: <span className="text-zinc-300">{preset.crf}</span></span>
                    <span>Preset: <span className="text-zinc-300">{preset.preset}</span></span>
                    <span>Audio: <span className="text-zinc-300">{preset.audioBitrate}</span></span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Filename */}
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Filename</label>
            <input
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              disabled={isExporting}
              className="w-full rounded border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-blue-500"
            />
          </div>

          {/* Output location */}
          {currentProject && (
            <div className="text-xs text-zinc-500">
              Output: <span className="text-zinc-400">{currentProject.projectDir}/exports/</span>
            </div>
          )}

          {/* Progress bar */}
          {isExporting && (
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-zinc-400">
                  {status === 'queued' ? 'Starting...' : status === 'running' ? `Exporting... ${progressPercent}%` : status}
                </span>
                <span className="text-zinc-500">{progressPercent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-700">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Completed status */}
          {status === 'completed' && !isExporting && (
            <div className="rounded border border-green-800 bg-green-900/30 px-3 py-2 text-xs text-green-400">
              Export completed successfully!
              {outputPath && (
                <div className="mt-1 text-green-500/70">{outputPath}</div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded border border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-zinc-700 px-4 py-3">
          {isExporting ? (
            <button
              onClick={handleCancel}
              className="rounded bg-red-600 px-4 py-1.5 text-sm text-white hover:bg-red-500"
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="rounded bg-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-600"
              >
                Close
              </button>
              {status !== 'completed' && (
                <button
                  onClick={handleExport}
                  className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500"
                >
                  Export
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
