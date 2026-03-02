/**
 * Source and Program monitors.
 *
 * In the MVP these are placeholder video displays with functional transport controls.
 * They will later use WebCodecs + Canvas for actual frame rendering.
 */

import { useRef } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { usePlaybackStore } from '../stores/playbackStore.js';

interface MonitorProps {
  type: 'source' | 'program';
}

export function Monitor({ type }: MonitorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentProject = useProjectStore((s) => s.currentProject);
  const label = type === 'source' ? 'Source' : 'Program';

  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const fps = usePlaybackStore((s) => s.fps);
  const inPoint = usePlaybackStore((s) => s.inPoint);
  const outPoint = usePlaybackStore((s) => s.outPoint);
  const togglePlayPause = usePlaybackStore((s) => s.togglePlayPause);
  const stepForward = usePlaybackStore((s) => s.stepForward);
  const stepBackward = usePlaybackStore((s) => s.stepBackward);
  const goToStart = usePlaybackStore((s) => s.goToStart);
  const goToEnd = usePlaybackStore((s) => s.goToEnd);
  const setInPoint = usePlaybackStore((s) => s.setInPoint);
  const setOutPoint = usePlaybackStore((s) => s.setOutPoint);

  // Format timecode HH:MM:SS:FF
  const formatTC = (frame: number): string => {
    const totalSeconds = Math.floor(frame / fps);
    const ff = Math.floor(frame % fps);
    const ss = totalSeconds % 60;
    const mm = Math.floor(totalSeconds / 60) % 60;
    const hh = Math.floor(totalSeconds / 3600);
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  };

  return (
    <div className="flex flex-1 flex-col">
      {/* Header with timecode */}
      <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {label}
        </span>
        <span className="font-mono text-xs text-zinc-400">
          {type === 'program' ? formatTC(currentFrame) : '00:00:00:00'}
        </span>
      </div>

      {/* Video area */}
      <div className="relative flex flex-1 items-center justify-center bg-black">
        {!currentProject ? (
          <span className="text-sm text-zinc-600">
            {type === 'source' ? 'No clip selected' : 'No sequence active'}
          </span>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <video
              ref={videoRef}
              className="max-h-full max-w-full"
              style={{ display: 'none' }}
            />
            <span className="text-sm text-zinc-600">
              {type === 'source' ? 'Select a clip to preview' : 'Playback ready'}
            </span>
          </div>
        )}

        {/* In/Out point indicators */}
        {type === 'program' && (inPoint !== null || outPoint !== null) && (
          <div className="absolute left-2 top-2 flex items-center gap-2 text-[10px]">
            {inPoint !== null && (
              <span className="rounded bg-blue-600/60 px-1.5 py-0.5 text-white">
                IN {formatTC(inPoint)}
              </span>
            )}
            {outPoint !== null && (
              <span className="rounded bg-blue-600/60 px-1.5 py-0.5 text-white">
                OUT {formatTC(outPoint)}
              </span>
            )}
          </div>
        )}

        {/* Transport controls */}
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1">
          {type === 'source' && (
            <TransportButton label="I" title="Mark In (I)" onClick={setInPoint} />
          )}
          <TransportButton label="⏮" title="Go to start (Home)" onClick={goToStart} />
          <TransportButton label="◀" title="Step back (←)" onClick={stepBackward} />
          <TransportButton
            label={isPlaying ? '⏸' : '▶'}
            title="Play/Pause (Space)"
            className="bg-zinc-700 px-3"
            onClick={togglePlayPause}
          />
          <TransportButton label="▶" title="Step forward (→)" onClick={stepForward} />
          <TransportButton label="⏭" title="Go to end (End)" onClick={goToEnd} />
          {type === 'source' && (
            <TransportButton label="O" title="Mark Out (O)" onClick={setOutPoint} />
          )}
        </div>
      </div>
    </div>
  );
}

function TransportButton({
  label,
  title,
  className = '',
  onClick,
}: {
  label: string;
  title: string;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-600 ${className}`}
    >
      {label}
    </button>
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
