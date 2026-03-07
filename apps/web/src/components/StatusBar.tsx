import { useProjectStore } from '../stores/projectStore.js';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';

export function StatusBar() {
  const isLoading = useProjectStore((s) => s.isLoading);
  const error = useProjectStore((s) => s.error);
  const mediaAssets = useProjectStore((s) => s.mediaAssets);
  const sequences = useProjectStore((s) => s.sequences);
  const setError = useProjectStore((s) => s.setError);

  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const fps = usePlaybackStore((s) => s.fps);
  const shuttleSpeed = usePlaybackStore((s) => s.shuttleSpeed);

  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const timelineTool = useSelectionStore((s) => s.timelineTool);
  const rippleMode = useSelectionStore((s) => s.rippleMode);
  const linkedSelection = useSelectionStore((s) => s.linkedSelection);

  // Playback speed indicator
  const speedLabel = (() => {
    if (!isPlaying) return null;
    if (shuttleSpeed === 1) return '▶ 1×';
    if (shuttleSpeed === -1) return '◀ 1×';
    if (shuttleSpeed > 0) return `▶▶ ${shuttleSpeed}×`;
    if (shuttleSpeed < 0) return `◀◀ ${Math.abs(shuttleSpeed)}×`;
    return null;
  })();

  // Sequence info
  const seqInfo =
    sequences.length > 0
      ? `${sequences[0].resolution?.width ?? '?'}×${sequences[0].resolution?.height ?? '?'} • ${fps}fps`
      : null;

  return (
    <footer className="flex h-6 items-center border-t border-zinc-700 bg-zinc-800 px-4 text-xs text-zinc-500">
      {/* Left: status */}
      <span className="flex items-center gap-3">
        {isLoading ? (
          <span className="text-blue-400">Loading...</span>
        ) : error ? (
          <span className="text-red-400">
            {error}
            <button
              className="ml-2 text-zinc-500 hover:text-zinc-300"
              onClick={() => setError(null)}
            >
              ✕
            </button>
          </span>
        ) : (
          <span className="text-zinc-500">Ready</span>
        )}

        {speedLabel && <span className="text-green-400">{speedLabel}</span>}

        {selectedClipIds.size > 0 && (
          <span className="text-zinc-400">
            {selectedClipIds.size} clip{selectedClipIds.size !== 1 ? 's' : ''} selected
          </span>
        )}

        <span className="text-zinc-500">Tool: {timelineTool === 'razor' ? 'Razor' : 'Select'}</span>
        {rippleMode && <span className="text-amber-400">Ripple</span>}
        <span className={linkedSelection ? 'text-cyan-300' : 'text-zinc-500'}>
          {linkedSelection ? 'Linked' : 'Unlinked'}
        </span>
      </span>

      {/* Right: info */}
      <span className="ml-auto flex items-center gap-4">
        {seqInfo && <span>{seqInfo}</span>}
        {mediaAssets.length > 0 && (
          <span>
            {mediaAssets.length} asset{mediaAssets.length !== 1 ? 's' : ''}
          </span>
        )}
        <span className="text-zinc-600">
          Space: play • J/K/L: shuttle • ←/→: 1f • ↑/↓: cuts • Home/End • C/V • M/[ ]
        </span>
      </span>
    </footer>
  );
}
