/**
 * Source Monitor — previews a single media asset with in/out marking
 * and insert-to-timeline.
 *
 * The Program Monitor is now a separate component (ProgramMonitor.tsx).
 *
 * Supports drag-and-drop: drop an asset from Project Browser to preview,
 * or drop OS files to import.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { api } from '../lib/api.js';
import type { ApiMediaAsset } from '../lib/api.js';

interface SourceDragPayload {
  asset: ApiMediaAsset;
  sourceInFrame?: number;
  sourceOutFrame?: number;
  audioOnly?: boolean;
}

export function SourceMonitor() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewfinderRef = useRef<HTMLDivElement>(null);
  const currentProject = useProjectStore((s) => s.currentProject);
  const uploadMedia = useProjectStore((s) => s.uploadMedia);
  const addClipToTrack = useProjectStore((s) => s.addClipToTrack);
  const sequences = useProjectStore((s) => s.sequences);

  const sourceAsset = useSelectionStore((s) => s.sourceAsset);
  const setSourceAsset = useSelectionStore((s) => s.setSourceAsset);
  const sourceInTime = useSelectionStore((s) => s.sourceInTime);
  const sourceOutTime = useSelectionStore((s) => s.sourceOutTime);
  const setSourceInTime = useSelectionStore((s) => s.setSourceInTime);
  const setSourceOutTime = useSelectionStore((s) => s.setSourceOutTime);
  const sourceInsertMode = useSelectionStore((s) => s.sourceInsertMode);
  const setSourceInsertMode = useSelectionStore((s) => s.setSourceInsertMode);
  const targetVideoTrackId = useSelectionStore((s) => s.targetVideoTrackId);
  const targetAudioTrackId = useSelectionStore((s) => s.targetAudioTrackId);

  const [isDragOver, setIsDragOver] = useState(false);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [timeInput, setTimeInput] = useState('00:00:00:00');
  const [sourceWaveform, setSourceWaveform] = useState<number[] | null>(null);
  const shuttleRateRef = useRef(0);
  const shuttleRafRef = useRef(0);
  const lastTsRef = useRef(0);
  const insertToTimelineRef = useRef<((mode: 'insert' | 'overwrite') => void) | null>(null);
  const dragModeRef = useRef<'playhead' | 'in' | 'out' | 'range' | null>(null);
  const rangeDragRef = useRef<{ inTime: number; outTime: number; anchorOffset: number } | null>(
    null,
  );

  const fps = usePlaybackStore((s) => s.fps);
  const effectiveDuration = Math.max(0, duration || sourceAsset?.duration || 0);
  const hasAudio =
    sourceAsset &&
    (sourceAsset.type === 'audio' ||
      (sourceAsset.type === 'video' && (sourceAsset.audioChannels ?? 0) > 0));

  useEffect(() => {
    if (!sourceAsset || !hasAudio) {
      setSourceWaveform(null);
      return;
    }
    let cancelled = false;
    api.media
      .waveform(sourceAsset.id, 1200)
      .then((data) => {
        if (cancelled) return;
        setSourceWaveform(data.peaks);
      })
      .catch(() => {
        if (cancelled) return;
        setSourceWaveform(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceAsset, hasAudio]);

  // --- Load video when sourceAsset changes ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (sourceAsset && (sourceAsset.type === 'video' || sourceAsset.type === 'audio')) {
      video.src = api.media.fileUrl(sourceAsset.id);
      video.load();
    } else {
      video.removeAttribute('src');
      video.load();
    }
    setIsVideoPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setZoom(1);
  }, [sourceAsset]);

  // --- Video event listeners ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setCurrentTime(video.currentTime);
    const onDur = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(d || sourceAsset?.duration || 0);
    };
    const onPlay = () => setIsVideoPlaying(true);
    const onPause = () => setIsVideoPlaying(false);
    const onEnd = () => setIsVideoPlaying(false);
    const onSeeked = () => setCurrentTime(video.currentTime);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('durationchange', onDur);
    video.addEventListener('loadedmetadata', onDur);
    video.addEventListener('loadeddata', onDur);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnd);
    video.addEventListener('seeked', onSeeked);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('durationchange', onDur);
      video.removeEventListener('loadedmetadata', onDur);
      video.removeEventListener('loadeddata', onDur);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnd);
      video.removeEventListener('seeked', onSeeked);
    };
  }, [sourceAsset?.duration]);

  // --- Transport ---
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.src) return;
    if (v.paused) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);
  const stepFwd = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.src) return;
    v.pause();
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : effectiveDuration;
    v.currentTime = Math.min(d, v.currentTime + 1 / fps);
    setCurrentTime(v.currentTime);
  }, [fps, effectiveDuration]);
  const stepBack = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.src) return;
    v.pause();
    v.currentTime = Math.max(0, v.currentTime - 1 / fps);
  }, [fps]);
  const toStart = useCallback(() => {
    const v = videoRef.current;
    if (v) v.currentTime = 0;
  }, []);
  const toEnd = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : effectiveDuration;
      v.currentTime = d;
      setCurrentTime(d);
    }
  }, [effectiveDuration]);

  // --- In / Out ---
  const markIn = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setSourceInTime(v.currentTime);
  }, [setSourceInTime]);

  const markOut = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setSourceOutTime(v.currentTime);
  }, [setSourceOutTime]);

  const getNormalizedRange = useCallback((): { inFrame?: number; outFrame?: number } => {
    let inFrame = sourceInTime != null ? Math.round(sourceInTime * fps) : undefined;
    let outFrame = sourceOutTime != null ? Math.round(sourceOutTime * fps) : undefined;

    if (inFrame != null && outFrame != null) {
      if (outFrame < inFrame) {
        const tmp = inFrame;
        inFrame = outFrame;
        outFrame = tmp;
      }
      if (outFrame === inFrame) {
        outFrame = inFrame + Math.max(1, Math.round(fps));
      }
    }

    return { inFrame, outFrame };
  }, [sourceInTime, sourceOutTime, fps]);

  const buildDragPayload = useCallback((): SourceDragPayload | null => {
    if (!sourceAsset) return null;
    const range = getNormalizedRange();
    return {
      asset: sourceAsset,
      sourceInFrame: range.inFrame,
      sourceOutFrame: range.outFrame,
    };
  }, [sourceAsset, getNormalizedRange]);

  const setDragPreview = useCallback(
    (e: React.DragEvent, payload: SourceDragPayload) => {
      const { sourceInFrame, sourceOutFrame, asset } = payload;
      const durationFrames = Math.max(
        1,
        (sourceOutFrame ?? (sourceInFrame ?? 0) + Math.round(fps)) - (sourceInFrame ?? 0),
      );
      const ghost = document.createElement('div');
      ghost.style.position = 'fixed';
      ghost.style.top = '-9999px';
      ghost.style.left = '-9999px';
      ghost.style.padding = '6px 10px';
      ghost.style.border = '1px solid rgba(96,165,250,0.7)';
      ghost.style.background = 'rgba(30,58,138,0.85)';
      ghost.style.color = '#dbeafe';
      ghost.style.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ghost.style.borderRadius = '6px';
      ghost.style.maxWidth = '280px';
      ghost.textContent = `${asset.name}  [${durationFrames}f]`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 12);
      setTimeout(() => {
        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      }, 0);
    },
    [fps],
  );

  const sourceShuttleForward = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.src) return;
    const speeds = [0, 1, 2, 4];
    const idx = speeds.indexOf(shuttleRateRef.current);
    const next = speeds[Math.min(idx + 1, speeds.length - 1)];
    shuttleRateRef.current = next;
    if (!v.paused) v.pause();
  }, []);

  const sourceShuttleReverse = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.src) return;
    const speeds = [0, -1, -2, -4];
    const idx = speeds.indexOf(shuttleRateRef.current);
    const next = speeds[Math.min(idx + 1, speeds.length - 1)];
    shuttleRateRef.current = next;
    if (!v.paused) v.pause();
  }, []);

  const sourceShuttlePause = useCallback(() => {
    shuttleRateRef.current = 0;
  }, []);

  useEffect(() => {
    const tick = (ts: number) => {
      const v = videoRef.current;
      if (v && shuttleRateRef.current !== 0) {
        if (lastTsRef.current === 0) lastTsRef.current = ts;
        const dt = (ts - lastTsRef.current) / 1000;
        lastTsRef.current = ts;
        const next = Math.max(
          0,
          Math.min(
            Number.isFinite(v.duration) && v.duration > 0 ? v.duration : effectiveDuration,
            v.currentTime + dt * shuttleRateRef.current,
          ),
        );
        v.currentTime = next;
      } else {
        lastTsRef.current = ts;
      }
      shuttleRafRef.current = requestAnimationFrame(tick);
    };
    shuttleRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (shuttleRafRef.current) cancelAnimationFrame(shuttleRafRef.current);
    };
  }, [effectiveDuration]);

  useEffect(() => {
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ command?: string }>).detail;
      const command = detail?.command;
      if (!command) return;
      switch (command) {
        case 'play-pause':
          sourceShuttlePause();
          togglePlay();
          break;
        case 'jkl-forward':
          sourceShuttleForward();
          break;
        case 'jkl-reverse':
          sourceShuttleReverse();
          break;
        case 'jkl-pause':
          sourceShuttlePause();
          break;
        case 'mark-in':
          markIn();
          break;
        case 'mark-out':
          markOut();
          break;
        case 'trim-before':
          setSourceInTime(currentTime);
          break;
        case 'trim-after':
          setSourceOutTime(currentTime);
          break;
        case 'insert':
          insertToTimelineRef.current?.('insert');
          break;
        case 'overwrite':
          insertToTimelineRef.current?.('overwrite');
          break;
        case 'zoom-in':
          setZoom((z) => Math.min(4, z * 1.25));
          break;
        case 'zoom-out':
          setZoom((z) => Math.max(0.25, z / 1.25));
          break;
      }
    };

    window.addEventListener('localcut:source-command', onCommand as EventListener);
    return () => window.removeEventListener('localcut:source-command', onCommand as EventListener);
  }, [
    togglePlay,
    sourceShuttleForward,
    sourceShuttleReverse,
    sourceShuttlePause,
    markIn,
    markOut,
    currentTime,
    setSourceInTime,
    setSourceOutTime,
  ]);

  // --- Insert to timeline (three-point editing) ---
  const insertToTimeline = useCallback(
    (mode: 'insert' | 'overwrite' = sourceInsertMode) => {
      if (!sourceAsset || !sequences.length) return;
      const seq = sequences[0];
      const seqData = seq?.data as
        | {
            tracks?: Array<{ id: string; type: string; name?: string; index?: number }>;
          }
        | undefined;
      const tracks = seqData?.tracks ?? [];
      if (!tracks.length) return;
      const isAudio = sourceAsset.type === 'audio';
      const videoTracks = tracks.filter((t) => t.type === 'video');
      const audioTracks = tracks.filter((t) => t.type === 'audio');
      const unlockedVideoTracks = videoTracks.filter(
        (t) => (t as { locked?: boolean }).locked !== true,
      );
      const unlockedAudioTracks = audioTracks.filter(
        (t) => (t as { locked?: boolean }).locked !== true,
      );
      const preferredVideo =
        unlockedVideoTracks.find((t) => (t.name ?? '').trim().toUpperCase() === 'V1') ??
        [...unlockedVideoTracks].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0] ??
        [...videoTracks].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
      const preferredAudio =
        unlockedAudioTracks.find((t) => (t.name ?? '').trim().toUpperCase() === 'A1') ??
        [...unlockedAudioTracks].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0] ??
        [...audioTracks].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
      let target = (isAudio ? preferredAudio : preferredVideo) ?? tracks[0];
      const explicitTargetId = isAudio ? targetAudioTrackId : targetVideoTrackId;
      if (explicitTargetId) {
        const explicit = tracks.find(
          (t) => t.id === explicitTargetId && t.type === (isAudio ? 'audio' : 'video'),
        );
        if (explicit && (explicit as { locked?: boolean }).locked !== true) {
          target = explicit;
        }
      }
      if (!target) return;
      const range = getNormalizedRange();
      const playheadFrame = usePlaybackStore.getState().currentFrame;
      addClipToTrack({
        trackId: target.id,
        asset: sourceAsset,
        startFrame: playheadFrame,
        sourceInFrame: range.inFrame,
        sourceOutFrame: range.outFrame,
        insertMode: mode === 'insert' ? 'ripple' : 'overwrite',
      });
    },
    [
      sourceAsset,
      sequences,
      addClipToTrack,
      fps,
      sourceInsertMode,
      getNormalizedRange,
      targetAudioTrackId,
      targetVideoTrackId,
    ],
  );

  useEffect(() => {
    insertToTimelineRef.current = insertToTimeline;
  }, [insertToTimeline]);

  // --- Drag & drop ---
  const dragCounter = useRef(0);
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (
      e.dataTransfer.types.includes('Files') ||
      e.dataTransfer.types.includes('application/x-localcut-asset')
    )
      setIsDragOver(true);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        uploadMedia(e.dataTransfer.files);
        return;
      }
      const assetData = e.dataTransfer.getData('application/x-localcut-asset');
      if (assetData) {
        try {
          setSourceAsset(JSON.parse(assetData) as ApiMediaAsset);
        } catch {
          /* ignore */
        }
      }
    },
    [uploadMedia, setSourceAsset],
  );

  // --- Timecode ---
  const formatTC = (time: number): string => {
    const assetFps = Math.round(fps);
    const frame = Math.floor(time * assetFps);
    const ff = frame % assetFps;
    const totalSec = Math.floor(time);
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  };

  const frameStepSec = 1 / Math.max(1, fps);

  const clientXToSnappedTime = useCallback(
    (clientX: number): number => {
      const el = viewfinderRef.current;
      if (!el || effectiveDuration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const raw = pct * effectiveDuration;
      const snappedFrame = Math.round(raw * fps);
      return Math.max(0, Math.min(effectiveDuration, snappedFrame / Math.max(1, fps)));
    },
    [effectiveDuration, fps],
  );

  const beginViewfinderDrag = useCallback(
    (mode: 'playhead' | 'in' | 'out', e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragModeRef.current = mode;
      const v = videoRef.current;
      if (v) v.pause();
      const t = clientXToSnappedTime(e.clientX);
      if (mode === 'playhead') {
        if (v) v.currentTime = t;
        setCurrentTime(t);
      } else if (mode === 'in') {
        const maxIn =
          sourceOutTime != null ? Math.max(0, sourceOutTime - frameStepSec) : effectiveDuration;
        const next = Math.min(t, maxIn);
        setSourceInTime(next);
      } else {
        const minOut = sourceInTime != null ? sourceInTime + frameStepSec : 0;
        const next = Math.max(t, minOut);
        setSourceOutTime(next);
      }
    },
    [
      clientXToSnappedTime,
      sourceOutTime,
      sourceInTime,
      frameStepSec,
      effectiveDuration,
      setSourceInTime,
      setSourceOutTime,
    ],
  );

  const beginRangeDrag = useCallback(
    (e: React.MouseEvent) => {
      if (!e.shiftKey) return;
      if (sourceInTime == null || sourceOutTime == null || effectiveDuration <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragModeRef.current = 'range';
      const t = clientXToSnappedTime(e.clientX);
      rangeDragRef.current = {
        inTime: sourceInTime,
        outTime: sourceOutTime,
        anchorOffset: t - sourceInTime,
      };
      const v = videoRef.current;
      if (v) v.pause();
    },
    [sourceInTime, sourceOutTime, effectiveDuration, clientXToSnappedTime],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const mode = dragModeRef.current;
      if (!mode) return;
      const t = clientXToSnappedTime(e.clientX);
      const v = videoRef.current;

      if (mode === 'playhead') {
        if (v) v.currentTime = t;
        setCurrentTime(t);
      } else if (mode === 'in') {
        const maxIn =
          sourceOutTime != null ? Math.max(0, sourceOutTime - frameStepSec) : effectiveDuration;
        setSourceInTime(Math.min(t, maxIn));
      } else if (mode === 'out') {
        const minOut = sourceInTime != null ? sourceInTime + frameStepSec : 0;
        setSourceOutTime(Math.max(t, minOut));
      } else {
        const rr = rangeDragRef.current;
        if (!rr) return;
        const span = rr.outTime - rr.inTime;
        let nextIn = t - rr.anchorOffset;
        nextIn = Math.max(0, Math.min(Math.max(0, effectiveDuration - span), nextIn));
        const snappedIn = Math.round(nextIn * fps) / Math.max(1, fps);
        const snappedOut = Math.min(effectiveDuration, snappedIn + span);
        setSourceInTime(snappedIn);
        setSourceOutTime(snappedOut);
      }
    };

    const onUp = () => {
      dragModeRef.current = null;
      rangeDragRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [
    clientXToSnappedTime,
    sourceInTime,
    sourceOutTime,
    frameStepSec,
    effectiveDuration,
    setSourceInTime,
    setSourceOutTime,
  ]);

  useEffect(() => {
    setTimeInput(formatTC(currentTime));
  }, [currentTime, fps]);

  const hasMedia = sourceAsset && (sourceAsset.type === 'video' || sourceAsset.type === 'audio');
  const hasImage = sourceAsset && sourceAsset.type === 'image';

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden ${isDragOver ? 'ring-2 ring-inset ring-blue-500/50' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-700 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Source
          </span>
          {sourceAsset && (
            <span className="max-w-[120px] truncate text-[10px] text-zinc-500">
              {sourceAsset.name}
            </span>
          )}
        </div>
        <span className="font-mono text-xs text-zinc-400">
          {sourceAsset ? formatTC(currentTime) : '00:00:00:00'}
        </span>
      </div>

      {/* Video area */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-blue-500/50 bg-blue-500/10">
            <span className="text-sm text-blue-300">Drop to preview</span>
          </div>
        )}

        {!currentProject ? (
          <span className="text-sm text-zinc-600">No clip selected</span>
        ) : (
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
            {hasMedia && (
              <video
                ref={videoRef}
                className="max-h-full max-w-full"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                draggable
                onDragStart={(e) => {
                  const payload = buildDragPayload();
                  if (!payload || !sourceAsset) return;
                  const assetPayload =
                    e.ctrlKey && sourceAsset.type === 'video'
                      ? { ...sourceAsset, audioOnly: true }
                      : sourceAsset;
                  const segmentPayload =
                    e.ctrlKey && sourceAsset.type === 'video'
                      ? { ...payload, audioOnly: true }
                      : payload;
                  e.dataTransfer.setData(
                    'application/x-localcut-asset',
                    JSON.stringify(assetPayload),
                  );
                  e.dataTransfer.setData(
                    'application/x-localcut-source-segment',
                    JSON.stringify(segmentPayload),
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                  setDragPreview(e, payload);
                }}
              />
            )}
            {sourceAsset?.type === 'audio' && sourceWaveform && (
              <div className="pointer-events-none absolute inset-0 flex items-center px-6">
                <WaveStrip peaks={sourceWaveform} height={180} color="rgba(74,222,128,0.7)" />
              </div>
            )}
            {hasImage && sourceAsset && (
              <img
                src={api.media.fileUrl(sourceAsset.id)}
                alt={sourceAsset.name}
                className="max-h-full max-w-full object-contain"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                draggable
                onDragStart={(e) => {
                  const payload = buildDragPayload();
                  if (!payload) return;
                  const assetPayload =
                    e.ctrlKey && sourceAsset?.type === 'video'
                      ? { ...sourceAsset, audioOnly: true }
                      : sourceAsset;
                  const segmentPayload =
                    e.ctrlKey && sourceAsset?.type === 'video'
                      ? { ...payload, audioOnly: true }
                      : payload;
                  e.dataTransfer.setData(
                    'application/x-localcut-asset',
                    JSON.stringify(assetPayload),
                  );
                  e.dataTransfer.setData(
                    'application/x-localcut-source-segment',
                    JSON.stringify(segmentPayload),
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                  setDragPreview(e, payload);
                }}
              />
            )}
            {!sourceAsset && (
              <span className="text-sm text-zinc-600">Select a clip to preview</span>
            )}
            {!hasMedia && <video ref={videoRef} className="hidden" />}
          </div>
        )}

        {sourceAsset?.type === 'video' && sourceWaveform && (
          <div className="pointer-events-none absolute bottom-16 left-4 right-4 h-14 rounded border border-emerald-600/30 bg-zinc-900/65 px-1">
            <WaveStrip peaks={sourceWaveform} height={50} color="rgba(16,185,129,0.7)" />
          </div>
        )}

        <div className="absolute right-2 top-2 flex items-center gap-1">
          <TBtn
            label="-"
            title="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}
          />
          <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
            {Math.round(zoom * 100)}%
          </span>
          <TBtn label="+" title="Zoom in" onClick={() => setZoom((z) => Math.min(4, z * 1.25))} />
          <TBtn label="Fit" title="Fit view" onClick={() => setZoom(1)} />
        </div>

        {/* In/Out badges */}
        {(sourceInTime != null || sourceOutTime != null) && (
          <div className="absolute left-2 top-2 flex items-center gap-2 text-[10px]">
            {sourceInTime != null && (
              <span className="rounded bg-cyan-600/70 px-1.5 py-0.5 text-white">
                IN {formatTC(sourceInTime)}
              </span>
            )}
            {sourceOutTime != null && (
              <span className="rounded bg-cyan-600/70 px-1.5 py-0.5 text-white">
                OUT {formatTC(sourceOutTime)}
              </span>
            )}
          </div>
        )}

        {/* Progress bar with in/out */}
        {hasMedia && effectiveDuration > 0 && (
          <div
            className="absolute bottom-10 left-4 right-4 h-1.5 cursor-pointer rounded bg-zinc-700"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              const v = videoRef.current;
              if (v) {
                v.currentTime = pct * effectiveDuration;
                setCurrentTime(v.currentTime);
              }
            }}
          >
            {sourceInTime != null && sourceOutTime != null && (
              <div
                className="absolute top-0 h-full rounded bg-cyan-500/30"
                style={{
                  left: `${(sourceInTime / effectiveDuration) * 100}%`,
                  width: `${((sourceOutTime - sourceInTime) / effectiveDuration) * 100}%`,
                }}
              />
            )}
            {sourceInTime != null && (
              <div
                className="absolute top-0 h-full w-0.5 bg-cyan-400"
                style={{ left: `${(sourceInTime / effectiveDuration) * 100}%` }}
              />
            )}
            {sourceOutTime != null && (
              <div
                className="absolute top-0 h-full w-0.5 bg-cyan-400"
                style={{ left: `${(sourceOutTime / effectiveDuration) * 100}%` }}
              />
            )}
            <div
              className="relative h-full rounded bg-blue-500"
              style={{ width: `${(currentTime / effectiveDuration) * 100}%` }}
            />
          </div>
        )}

        {/* Transport */}
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-0.5">
          <TBtn label="I" title="Mark In (I)" onClick={markIn} active={sourceInTime != null} />
          <TBtn label="⏮" title="Go to start" onClick={toStart} />
          <TBtn label="◀" title="Step back" onClick={stepBack} />
          <TBtn
            label={isVideoPlaying ? '⏸' : '▶'}
            title="Play/Pause"
            className="bg-zinc-700 px-3"
            onClick={togglePlay}
          />
          <TBtn label="▶" title="Step forward" onClick={stepFwd} />
          <TBtn label="⏭" title="Go to end" onClick={toEnd} />
          <TBtn label="O" title="Mark Out (O)" onClick={markOut} active={sourceOutTime != null} />
          <TBtn
            label="Clr"
            title="Clear In/Out"
            onClick={() => {
              setSourceInTime(null);
              setSourceOutTime(null);
            }}
          />
          <div className="mx-1 h-4 w-px bg-zinc-600" />
          <TBtn
            label="Insert"
            title="Insert to timeline (,)"
            className="bg-blue-600/40 hover:bg-blue-500/60"
            onClick={() => {
              setSourceInsertMode('insert');
              insertToTimeline('insert');
            }}
          />
          <TBtn
            label="Overwrite"
            title="Overwrite to timeline"
            className="bg-zinc-700/70 hover:bg-zinc-600/80"
            onClick={() => {
              setSourceInsertMode('overwrite');
              insertToTimeline('overwrite');
            }}
          />
        </div>
      </div>

      <div className="shrink-0 border-t border-zinc-700 bg-zinc-900/70 px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-500">
          <span>Viewfinder</span>
          <span>{formatTC(currentTime)}</span>
        </div>
        <div
          ref={viewfinderRef}
          className="relative h-7 select-none rounded border border-zinc-700 bg-zinc-800"
          onMouseDown={(e) => beginViewfinderDrag('playhead', e)}
        >
          {effectiveDuration > 0 && sourceInTime != null && sourceOutTime != null && (
            <div
              className="absolute top-0 bottom-0 rounded bg-cyan-500/30 ring-1 ring-cyan-400/60"
              style={{
                left: `${(sourceInTime / effectiveDuration) * 100}%`,
                width: `${((sourceOutTime - sourceInTime) / effectiveDuration) * 100}%`,
              }}
              onMouseDown={beginRangeDrag}
              title="Shift+Drag to move In/Out range"
            />
          )}

          {effectiveDuration > 0 && sourceInTime != null && (
            <button
              className="absolute top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize bg-cyan-300/90"
              style={{ left: `${(sourceInTime / effectiveDuration) * 100}%` }}
              onMouseDown={(e) => beginViewfinderDrag('in', e)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSourceInTime(0);
              }}
              title="Drag In point"
            />
          )}

          {effectiveDuration > 0 && sourceOutTime != null && (
            <button
              className="absolute top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize bg-cyan-300/90"
              style={{ left: `${(sourceOutTime / effectiveDuration) * 100}%` }}
              onMouseDown={(e) => beginViewfinderDrag('out', e)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSourceOutTime(effectiveDuration);
              }}
              title="Drag Out point"
            />
          )}

          {effectiveDuration > 0 && (
            <div
              className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-blue-400"
              style={{ left: `${(currentTime / effectiveDuration) * 100}%` }}
            />
          )}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <input
            value={timeInput}
            onChange={(e) => setTimeInput(e.target.value)}
            onBlur={() => {
              const sec = parseTimecodeToSeconds(timeInput, fps);
              const v = videoRef.current;
              if (v && sec != null) {
                const d =
                  Number.isFinite(v.duration) && v.duration > 0 ? v.duration : effectiveDuration;
                v.currentTime = Math.min(d || sec, sec);
                setCurrentTime(v.currentTime);
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const sec = parseTimecodeToSeconds(timeInput, fps);
              const v = videoRef.current;
              if (v && sec != null) {
                const d =
                  Number.isFinite(v.duration) && v.duration > 0 ? v.duration : effectiveDuration;
                v.currentTime = Math.min(d || sec, sec);
                setCurrentTime(v.currentTime);
              }
            }}
            className="w-32 rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-200"
          />
          <span className="text-[10px] text-zinc-500">I/O + seek exact position</span>
          <span className="ml-auto rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400">
            Mode: {sourceInsertMode === 'insert' ? 'Insert' : 'Overwrite'}
          </span>
        </div>
      </div>
    </div>
  );
}

function WaveStrip({ peaks, height, color }: { peaks: number[]; height: number; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;
    canvas.width = 1200;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    const mid = canvas.height / 2;
    const step = canvas.width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(0, Math.min(1, peaks[i])) * mid;
      const x = i * step;
      ctx.fillRect(x, mid - amp, Math.max(1, step * 0.8), amp * 2);
    }
  }, [peaks, height, color]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}

function TBtn({
  label,
  title,
  className = '',
  onClick,
  active,
}: {
  label: string;
  title: string;
  className?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-600 ${active ? 'text-cyan-400' : ''} ${className}`}
    >
      {label}
    </button>
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function parseTimecodeToSeconds(value: string, fps: number): number | null {
  const m = value.trim().match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return null;
  const safeFps = Math.max(1, Math.round(fps));
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ff = Number(m[4]);
  const total = hh * 3600 + mm * 60 + ss + ff / safeFps;
  if (!Number.isFinite(total)) return null;
  return Math.max(0, total);
}
