import { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import type { TimelineClipData, TimelineTrackData } from '../stores/projectStore.js';
import { api } from '../lib/api.js';

interface ActiveLayer {
  clip: TimelineClipData;
  trackIndex: number;
  sourceTimeSec: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  const [_, hh, mm, ss, ff] = m;
  const safeFps = Math.max(1, Math.round(fps));
  const frame =
    Number(hh) * 3600 * safeFps + Number(mm) * 60 * safeFps + Number(ss) * safeFps + Number(ff);
  if (!Number.isFinite(frame)) return null;
  return Math.max(0, frame);
}

function resolveActiveLayers(
  tracks: TimelineTrackData[],
  currentFrame: number,
  fps: number,
): ActiveLayer[] {
  const active: ActiveLayer[] = [];
  for (const track of tracks) {
    if (track.type !== 'video' || track.muted || !track.visible) continue;
    const clips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
    for (const clip of clips) {
      const start = clip.startFrame;
      const end = clip.startFrame + clip.durationFrames;
      if (currentFrame < start || currentFrame >= end) continue;
      if (!clip.mediaAssetId || (clip.type !== 'video' && clip.type !== 'image')) continue;
      const sourceIn = clip.sourceInFrame ?? 0;
      const sourceOut = clip.sourceOutFrame ?? sourceIn + clip.durationFrames;
      const speed = clip.speed ?? 1;
      const rel = currentFrame - start;
      let sourceFrame: number;
      if (speed >= 0) {
        sourceFrame = sourceIn + rel * speed;
      } else {
        sourceFrame = sourceOut - 1 + rel * speed;
      }
      sourceFrame = Math.max(sourceIn, Math.min(sourceOut - 1, sourceFrame));
      active.push({
        clip,
        trackIndex: track.index,
        sourceTimeSec: sourceFrame / Math.max(1, fps),
      });
      break;
    }
  }

  active.sort((a, b) => b.trackIndex - a.trackIndex);
  return active;
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

function safeScale(value: number): number {
  if (Math.abs(value) < 0.01) return value < 0 ? -0.01 : 0.01;
  return value;
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
    startX: number;
    startY: number;
    posX: number;
    posY: number;
    scaleX: number;
    scaleY: number;
  } | null>(null);

  const transformPreviewRef = useRef<{
    clipId: string;
    positionX: number;
    positionY: number;
    scaleX: number;
    scaleY: number;
  } | null>(null);

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
  const liftRangeByInOut = useProjectStore((s) => s.liftRangeByInOut);
  const extractRangeByInOut = useProjectStore((s) => s.extractRangeByInOut);
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const targetVideoTrackId = useSelectionStore((s) => s.targetVideoTrackId);
  const targetAudioTrackId = useSelectionStore((s) => s.targetAudioTrackId);
  const linkedSelection = useSelectionStore((s) => s.linkedSelection);
  const selectClip = useSelectionStore((s) => s.selectClip);

  const activeLayers = useMemo(() => {
    const seq = sequences[0];
    if (!seq) return [] as ActiveLayer[];
    const data = seq.data as { tracks?: TimelineTrackData[] } | undefined;
    return resolveActiveLayers(data?.tracks ?? [], currentFrame, fps);
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
    const activeIds = new Set(activeLayers.map((l) => l.clip.id));
    for (const [id, video] of videoByClipIdRef.current) {
      if (!activeIds.has(id)) video.pause();
    }
  }, [activeLayers]);

  const getDisplayRect = useCallback(
    (layer: ActiveLayer): Rect | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const video = getOrCreateVideo(layer.clip);
      if (!video || video.readyState < 1) return null;

      const frame = frameFitRect(
        canvas.width,
        canvas.height,
        seqResolution.width,
        seqResolution.height,
      );
      const vw = video.videoWidth || seqResolution.width;
      const vh = video.videoHeight || seqResolution.height;
      const tr =
        transformPreviewRef.current?.clipId === layer.clip.id ? transformPreviewRef.current : null;

      const px = tr?.positionX ?? layer.clip.positionX ?? 0;
      const py = tr?.positionY ?? layer.clip.positionY ?? 0;
      const sx = tr?.scaleX ?? layer.clip.scaleX ?? 1;
      const sy = tr?.scaleY ?? layer.clip.scaleY ?? 1;

      const width = vw * frame.scale * Math.abs(sx) * zoom;
      const height = vh * frame.scale * Math.abs(sy) * zoom;
      const cx = canvas.width / 2 + pan.x + px * zoom;
      const cy = canvas.height / 2 + pan.y + py * zoom;

      return {
        x: cx - width / 2,
        y: cy - height / 2,
        width,
        height,
      };
    },
    [getOrCreateVideo, zoom, pan, seqResolution.width, seqResolution.height],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let drewAny = false;

    for (const layer of activeLayers) {
      const video = getOrCreateVideo(layer.clip);
      if (!video) continue;

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
      if (!drewAny) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      const frame = frameFitRect(
        canvas.width,
        canvas.height,
        seqResolution.width,
        seqResolution.height,
      );
      const vw = video.videoWidth || seqResolution.width;
      const vh = video.videoHeight || seqResolution.height;
      const drawWidth = vw * frame.scale;
      const drawHeight = vh * frame.scale;

      const tr =
        transformPreviewRef.current?.clipId === layer.clip.id ? transformPreviewRef.current : null;

      const px = tr?.positionX ?? layer.clip.positionX ?? 0;
      const py = tr?.positionY ?? layer.clip.positionY ?? 0;
      const sx = tr?.scaleX ?? layer.clip.scaleX ?? 1;
      const sy = tr?.scaleY ?? layer.clip.scaleY ?? 1;
      const rot = layer.clip.rotation ?? 0;
      const opacity = Math.max(0, Math.min(1, layer.clip.opacity ?? 1));
      const brightness = Math.max(0, layer.clip.brightness ?? 1);
      const contrast = Math.max(0, layer.clip.contrast ?? 1);
      const saturation = Math.max(0, layer.clip.saturation ?? 1);
      const hue = layer.clip.hue ?? 0;
      const vignette = Math.max(-1, Math.min(1, layer.clip.vignette ?? 0));

      ctx.save();
      ctx.translate(canvas.width / 2 + pan.x, canvas.height / 2 + pan.y);
      ctx.scale(zoom, zoom);
      ctx.translate(-canvas.width / 2, -canvas.height / 2);

      ctx.globalAlpha = opacity;
      ctx.filter = `brightness(${brightness * 100}%) contrast(${contrast * 100}%) saturate(${saturation * 100}%) hue-rotate(${hue}deg)`;
      ctx.translate(canvas.width / 2 + px, canvas.height / 2 + py);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.scale(safeScale(sx), safeScale(sy));
      ctx.translate(-canvas.width / 2, -canvas.height / 2);

      const dx = canvas.width / 2 - drawWidth / 2;
      const dy = canvas.height / 2 - drawHeight / 2;
      ctx.drawImage(video, dx, dy, drawWidth, drawHeight);
      if (Math.abs(vignette) > 0.001) {
        const inner = Math.min(drawWidth, drawHeight) * 0.2;
        const outer = Math.max(drawWidth, drawHeight) * 0.7;
        const grad = ctx.createRadialGradient(
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
        ctx.fillStyle = grad;
        ctx.fillRect(dx, dy, drawWidth, drawHeight);
      }
      ctx.restore();
      drewAny = true;
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

    lastPlayingRef.current = isPlaying;
  }, [
    activeLayers,
    isPlaying,
    shuttleSpeed,
    getOrCreateVideo,
    zoom,
    pan,
    renderTick,
    seqResolution.width,
    seqResolution.height,
    controlledLayer,
    getDisplayRect,
  ]);

  useEffect(() => {
    if (isPlaying) return;
    setRenderTick((v) => v + 1);
  }, [currentFrame, isPlaying]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
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
      const drag = dragRef.current;
      const preview = transformPreviewRef.current;
      if (drag && preview && preview.clipId === drag.clipId) {
        void updateClipProperties(drag.clipId, {
          positionX: preview.positionX,
          positionY: preview.positionY,
          scaleX: preview.scaleX,
          scaleY: preview.scaleY,
        });
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
  }, [updateClipProperties, zoom]);

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
    [activeLayers, isPlaying, getDisplayRect, selectionArray, selectClip],
  );

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
        </div>

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
          <TBtn label="⏮" title="Go to start" onClick={goToStart} />
          <TBtn label="◀" title="Step back" onClick={stepBackward} />
          <TBtn
            label={isPlaying ? '⏸' : '▶'}
            title="Play / Pause (Space)"
            className="bg-zinc-700 px-3"
            onClick={togglePlayPause}
          />
          <TBtn label="▶" title="Step forward" onClick={stepForward} />
          <TBtn label="⏭" title="Go to end" onClick={goToEnd} />
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
            Drag clip in viewer to move, corner to resize
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
