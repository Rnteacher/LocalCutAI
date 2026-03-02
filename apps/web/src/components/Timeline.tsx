/**
 * Timeline panel — the core editing surface.
 *
 * Shows track headers, clip blocks, playhead, and time ruler.
 * Supports drag-and-drop from project browser and clip selection.
 */

import { useState, useRef, useCallback } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';

/** Pixels per frame at zoom level 1.0 */
const BASE_PX_PER_FRAME = 4;

interface TimelineTrack {
  id: string;
  name: string;
  type: 'video' | 'audio';
  clips: TimelineClip[];
  muted: boolean;
  locked: boolean;
  solo?: boolean;
}

interface TimelineClip {
  id: string;
  name: string;
  type: string;
  startFrame: number;
  durationFrames: number;
  mediaAssetId?: string | null;
}

export function Timeline() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const sequences = useProjectStore((s) => s.sequences);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const inPoint = usePlaybackStore((s) => s.inPoint);
  const outPoint = usePlaybackStore((s) => s.outPoint);
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const selectClip = useSelectionStore((s) => s.selectClip);
  const clearClipSelection = useSelectionStore((s) => s.clearClipSelection);

  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const pxPerFrame = BASE_PX_PER_FRAME * zoom;
  const fps = 24;

  // Parse tracks from sequence data (MVP: use first sequence)
  const tracks: TimelineTrack[] = (() => {
    if (!sequences.length) return [];
    const data = sequences[0]?.data as { tracks?: TimelineTrack[] } | undefined;
    return data?.tracks ?? [];
  })();

  // Calculate total timeline width
  let maxFrame = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      const end = clip.startFrame + clip.durationFrames;
      if (end > maxFrame) maxFrame = end;
    }
  }
  const totalWidth = Math.max((maxFrame + fps * 10) * pxPerFrame, 2000);

  const handleRulerClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollLeft;
      const frame = Math.max(0, Math.round(x / pxPerFrame));
      setCurrentFrame(frame);
      clearClipSelection();
    },
    [pxPerFrame, scrollLeft, setCurrentFrame, clearClipSelection],
  );

  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only if clicking empty space (not a clip)
      if ((e.target as HTMLElement).dataset.clip !== 'true') {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + scrollLeft;
        const frame = Math.max(0, Math.round(x / pxPerFrame));
        setCurrentFrame(frame);
        clearClipSelection();
      }
    },
    [pxPerFrame, scrollLeft, setCurrentFrame, clearClipSelection],
  );

  const handleClipClick = useCallback(
    (clipId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      selectClip(clipId, e.shiftKey || e.ctrlKey || e.metaKey);
    },
    [selectClip],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const assetData = e.dataTransfer.getData('application/x-localcut-asset');
      if (assetData) {
        try {
          const asset = JSON.parse(assetData);
          // TODO: Add clip to sequence via API
          console.log('Dropped asset on timeline:', asset.name);
        } catch {
          // Ignore parse errors
        }
      }
    },
    [],
  );

  const formatTimecode = (frame: number) => {
    const totalSec = frame / fps;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    const f = frame % fps;
    return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
  };

  if (!currentProject) {
    return (
      <div className="flex h-72 flex-col bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Timeline
          </span>
          <span className="font-mono text-xs text-zinc-500">00:00:00:00</span>
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">
          Open a project to start editing
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-72 flex-col bg-zinc-900">
      {/* Timeline header */}
      <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Timeline
          </span>
          {sequences.length > 0 && (
            <span className="text-[10px] text-zinc-600">{sequences[0].name}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Zoom control */}
          <div className="flex items-center gap-1">
            <button
              className="text-xs text-zinc-400 hover:text-white"
              onClick={() => setZoom((z) => Math.max(0.25, z / 1.5))}
            >
              −
            </button>
            <span className="w-10 text-center font-mono text-xs text-zinc-500">
              {Math.round(zoom * 100)}%
            </span>
            <button
              className="text-xs text-zinc-400 hover:text-white"
              onClick={() => setZoom((z) => Math.min(8, z * 1.5))}
            >
              +
            </button>
          </div>
          <span className="font-mono text-xs text-zinc-400">
            {formatTimecode(currentFrame)}
          </span>
        </div>
      </div>

      {/* Timeline body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Track headers */}
        <div className="w-32 flex-shrink-0 border-r border-zinc-700">
          {/* Ruler header spacer */}
          <div className="h-5 border-b border-zinc-700" />
          {tracks.map((track) => (
            <div
              key={track.id}
              className="flex h-16 items-center border-b border-zinc-800 px-2"
            >
              <div className="flex-1">
                <div className="text-xs font-medium text-zinc-300">{track.name}</div>
                <div className="mt-0.5 flex gap-1">
                  <button
                    className={`rounded px-1 text-[10px] ${track.muted ? 'bg-red-500/20 text-red-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    title="Mute"
                  >
                    M
                  </button>
                  <button
                    className={`rounded px-1 text-[10px] ${track.solo ? 'bg-yellow-500/20 text-yellow-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    title="Solo"
                  >
                    S
                  </button>
                  <button
                    className={`rounded px-1 text-[10px] ${track.locked ? 'bg-orange-500/20 text-orange-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    title="Lock"
                  >
                    🔒
                  </button>
                </div>
              </div>
            </div>
          ))}
          {tracks.length === 0 && (
            <div className="flex h-16 items-center px-2 text-xs text-zinc-600">
              No tracks
            </div>
          )}
        </div>

        {/* Timeline clip area */}
        <div
          ref={containerRef}
          className="relative flex-1 overflow-x-auto overflow-y-hidden"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          style={{ minWidth: 0 }}
        >
          <div style={{ width: totalWidth, position: 'relative' }}>
            {/* Time ruler */}
            <div
              className="sticky top-0 z-10 h-5 border-b border-zinc-700 bg-zinc-900/90 cursor-pointer"
              onClick={handleRulerClick}
            >
              <TimeRuler pxPerFrame={pxPerFrame} fps={fps} scrollLeft={scrollLeft} />

              {/* In/Out point markers on ruler */}
              {inPoint !== null && (
                <div
                  className="absolute top-0 h-full w-0.5 bg-blue-500/70"
                  style={{ left: inPoint * pxPerFrame }}
                />
              )}
              {outPoint !== null && (
                <div
                  className="absolute top-0 h-full w-0.5 bg-blue-500/70"
                  style={{ left: outPoint * pxPerFrame }}
                />
              )}
            </div>

            {/* In/Out range highlight */}
            {inPoint !== null && outPoint !== null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 bg-blue-500/5"
                style={{
                  left: inPoint * pxPerFrame,
                  width: (outPoint - inPoint) * pxPerFrame,
                }}
              />
            )}

            {/* Track rows */}
            {tracks.map((track) => (
              <div
                key={track.id}
                className={`relative h-16 border-b border-zinc-800 ${
                  track.type === 'video' ? 'bg-zinc-900/30' : 'bg-zinc-900/50'
                }`}
                onClick={handleTrackClick}
              >
                {track.clips.map((clip) => {
                  const isSelected = selectedClipIds.has(clip.id);
                  return (
                    <div
                      key={clip.id}
                      data-clip="true"
                      className={`absolute top-1 bottom-1 cursor-pointer rounded border transition-colors ${
                        isSelected
                          ? 'border-white ring-1 ring-white/30'
                          : clip.type === 'video' || clip.type === 'image'
                            ? 'border-blue-500/40 hover:border-blue-400/60'
                            : 'border-green-500/40 hover:border-green-400/60'
                      } ${
                        clip.type === 'video' || clip.type === 'image'
                          ? 'bg-blue-500/20'
                          : 'bg-green-500/20'
                      }`}
                      style={{
                        left: clip.startFrame * pxPerFrame,
                        width: Math.max(clip.durationFrames * pxPerFrame, 4),
                      }}
                      onClick={(e) => handleClipClick(clip.id, e)}
                    >
                      <div className="truncate px-1 py-0.5 text-[10px] text-zinc-300">
                        {clip.name}
                      </div>
                      {/* Trim handles */}
                      <div className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-white/20" />
                      <div className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-white/20" />
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-red-500"
              style={{ left: currentFrame * pxPerFrame }}
            >
              <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[6px] border-t-red-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time ruler sub-component
// ---------------------------------------------------------------------------

function TimeRuler({
  pxPerFrame,
  fps,
  scrollLeft,
}: {
  pxPerFrame: number;
  fps: number;
  scrollLeft: number;
}) {
  const framesPerMark = Math.max(1, Math.round(fps / (pxPerFrame / 2)));
  const startFrame = Math.floor(scrollLeft / pxPerFrame);
  const marks: { frame: number; label: string }[] = [];

  for (let f = startFrame - (startFrame % framesPerMark); marks.length < 60; f += framesPerMark) {
    if (f < 0) continue;
    const sec = f / fps;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    marks.push({ frame: f, label: `${m}:${pad(s)}` });
  }

  return (
    <>
      {marks.map((mark) => (
        <div
          key={mark.frame}
          className="absolute top-0 h-full border-l border-zinc-700/50"
          style={{ left: mark.frame * pxPerFrame }}
        >
          <span className="ml-1 text-[9px] text-zinc-600">{mark.label}</span>
        </div>
      ))}
    </>
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
