import { useState, useRef, useCallback, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import type { ApiMediaAsset } from '../lib/api.js';
import { api } from '../lib/api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

function MediaIcon({ type }: { type: string }) {
  switch (type) {
    case 'video':
      return <span className="text-blue-400">🎬</span>;
    case 'audio':
      return <span className="text-green-400">🎵</span>;
    case 'image':
      return <span className="text-amber-400">🖼</span>;
    default:
      return <span>📄</span>;
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MediaItem({
  asset,
  onSelect,
  isSelected,
  mode,
}: {
  asset: ApiMediaAsset;
  onSelect: (asset: ApiMediaAsset) => void;
  isSelected: boolean;
  mode: 'list' | 'grid';
}) {
  const isVisual = asset.type === 'video' || asset.type === 'image';

  if (mode === 'grid') {
    return (
      <button
        className={`group flex w-full flex-col overflow-hidden rounded-md border text-left transition-colors ${
          isSelected
            ? 'border-blue-500/60 bg-blue-500/15 text-blue-100'
            : 'border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-700/60'
        }`}
        onClick={() => onSelect(asset)}
        draggable
        onDragStart={(e) => {
          const payload =
            e.ctrlKey && asset.type === 'video' ? { ...asset, audioOnly: true } : asset;
          e.dataTransfer.setData('application/x-localcut-asset', JSON.stringify(payload));
          e.dataTransfer.effectAllowed = 'copy';
        }}
      >
        <div className="relative h-20 w-full overflow-hidden bg-zinc-900">
          {asset.type === 'image' && (
            <img
              src={api.media.fileUrl(asset.id)}
              alt={asset.name}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          )}
          {asset.type === 'video' && (
            <video
              src={api.media.fileUrl(asset.id)}
              className="h-full w-full object-cover"
              muted
              preload="metadata"
            />
          )}
          {asset.type === 'audio' && (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-emerald-900/40 to-zinc-900">
              <span className="text-lg">🎵</span>
            </div>
          )}
          {!isVisual && asset.type !== 'audio' && (
            <div className="flex h-full w-full items-center justify-center text-lg">📄</div>
          )}
        </div>
        <div className="space-y-0.5 p-2">
          <div className="truncate text-[11px] font-medium">{asset.name}</div>
          <div className="flex flex-wrap gap-1 text-[10px] text-zinc-500">
            <span>{asset.type}</span>
            {asset.duration != null && <span>{formatDuration(asset.duration)}</span>}
          </div>
        </div>
      </button>
    );
  }

  return (
    <button
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
        isSelected
          ? 'bg-blue-500/20 text-blue-200 ring-1 ring-blue-500/40'
          : 'text-zinc-300 hover:bg-zinc-700/50'
      }`}
      onClick={() => onSelect(asset)}
      draggable
      onDragStart={(e) => {
        const payload = e.ctrlKey && asset.type === 'video' ? { ...asset, audioOnly: true } : asset;
        e.dataTransfer.setData('application/x-localcut-asset', JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className="h-9 w-12 overflow-hidden rounded border border-zinc-700 bg-zinc-900">
        {asset.type === 'image' && (
          <img
            src={api.media.fileUrl(asset.id)}
            alt={asset.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        )}
        {asset.type === 'video' && (
          <video
            src={api.media.fileUrl(asset.id)}
            className="h-full w-full object-cover"
            muted
            preload="metadata"
          />
        )}
        {asset.type === 'audio' && (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-emerald-900/40 to-zinc-900">
            <span className="text-xs">🎵</span>
          </div>
        )}
        {!isVisual && asset.type !== 'audio' && (
          <div className="flex h-full w-full items-center justify-center">
            <MediaIcon type={asset.type} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{asset.name}</div>
        <div className="flex gap-2 text-[10px] text-zinc-500">
          <span className="uppercase">{asset.type}</span>
          {asset.duration != null && <span>{formatDuration(asset.duration)}</span>}
          {asset.resolution && (
            <span>
              {asset.resolution.width}×{asset.resolution.height}
            </span>
          )}
          <span>{formatFileSize(asset.fileSize)}</span>
        </div>
      </div>
    </button>
  );
}

export function ProjectBrowser({ onToggleCollapse }: { onToggleCollapse?: () => void }) {
  const {
    currentProject,
    mediaAssets,
    closeProject,
    deleteMedia,
    dedupeMedia,
    pickMedia,
    uploadMedia,
    importMedia,
    isLoading,
    sequences,
  } = useProjectStore();

  const setSourceAsset = useSelectionStore((s) => s.setSourceAsset);

  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'video' | 'audio' | 'image'>('all');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [dedupeStatus, setDedupeStatus] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | {
    type: 'media';
    id: string;
    title: string;
    message: string;
    warning?: string;
    actionLabel: string;
  }>(null);
  const mediaClipboardRef = useRef<string[]>([]);

  /** Open native file picker and link media from original file paths. */
  const handleImport = useCallback(async () => {
    setDedupeStatus(null);
    await pickMedia();
  }, [pickMedia]);

  /** Handle files dropped from OS file explorer */
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      setDedupeStatus(null);

      // Only process native file drops, not internal asset drags
      if (e.dataTransfer.files.length > 0) {
        uploadMedia(e.dataTransfer.files);
      }
    },
    [uploadMedia],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Only show drop indicator for native file drops
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const getAssetUsageCount = useCallback(
    (assetId: string): number => {
      let count = 0;
      for (const seq of sequences) {
        const data = seq.data as {
          tracks?: Array<{ clips?: Array<{ mediaAssetId?: string | null }> }>;
        };
        const tracks = data?.tracks ?? [];
        for (const t of tracks) {
          for (const c of t.clips ?? []) {
            if (c.mediaAssetId === assetId) count++;
          }
        }
      }
      return count;
    },
    [sequences],
  );

  const filteredAssets = mediaAssets.filter((asset) => {
    const matchesType = typeFilter === 'all' || asset.type === typeFilter;
    const matchesSearch = asset.name.toLowerCase().includes(search.toLowerCase().trim());
    return matchesType && matchesSearch;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (!currentProject) return;
      const panel = useSelectionStore.getState().activePanel;
      if (panel !== 'project-browser') return;

      const selectedIndex = filteredAssets.findIndex((a) => a.id === selectedAsset);
      const selected = selectedAsset ? mediaAssets.find((a) => a.id === selectedAsset) : null;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filteredAssets.length === 0) return;
        const nextIndex =
          selectedIndex < 0 ? 0 : Math.min(filteredAssets.length - 1, selectedIndex + 1);
        const next = filteredAssets[nextIndex];
        if (!next) return;
        setSelectedAsset(next.id);
        setSourceAsset(next);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filteredAssets.length === 0) return;
        const nextIndex = selectedIndex < 0 ? 0 : Math.max(0, selectedIndex - 1);
        const next = filteredAssets[nextIndex];
        if (!next) return;
        setSelectedAsset(next.id);
        setSourceAsset(next);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        if (!selected) return;
        e.preventDefault();
        setSourceAsset(selected);
        useSelectionStore.getState().setActivePanel('source-monitor');
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (!selected) return;
        e.preventDefault();
        mediaClipboardRef.current = [selected.filePath];
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        if (mediaClipboardRef.current.length > 0) {
          void importMedia(mediaClipboardRef.current);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        if (!selected) return;
        e.preventDefault();
        void importMedia([selected.filePath]);
        return;
      }

      const wantsDelete =
        e.key === 'Delete' ||
        e.key === 'Backspace' ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X'));
      if (!wantsDelete || !selected) return;

      e.preventDefault();
      mediaClipboardRef.current = [selected.filePath];
      const usage = getAssetUsageCount(selected.id);
      setConfirm({
        type: 'media',
        id: selected.id,
        title: 'Delete media asset?',
        message: `Delete \"${selected.name}\" from this project?`,
        warning:
          usage > 0
            ? `This media is used by ${usage} clip${usage !== 1 ? 's' : ''} in the timeline. Deleting it will remove those clips.`
            : undefined,
        actionLabel: 'Delete Media',
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    currentProject,
    selectedAsset,
    mediaAssets,
    filteredAssets,
    getAssetUsageCount,
    importMedia,
    setSourceAsset,
  ]);

  useEffect(() => {
    const onOpenImport = () => handleImport();
    window.addEventListener('localcut:open-media-import', onOpenImport);
    return () => window.removeEventListener('localcut:open-media-import', onOpenImport);
  }, [handleImport]);

  if (!currentProject) return null;

  // Show media browser when project is open
  return (
    <aside
      className={`flex w-72 flex-shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/70 ${
        isDragOver ? 'ring-2 ring-inset ring-blue-500/50' : ''
      }`}
      onMouseDown={() => useSelectionStore.getState().setActivePanel('project-browser')}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-2">
        <div className="min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Media
          </span>
          <div className="truncate text-[10px] text-zinc-600">{currentProject.name}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="lc-btn px-2 py-1 text-[10px]"
            onClick={onToggleCollapse}
            title="Collapse media panel"
          >
            ◀
          </button>
          <button
            className="lc-btn px-2 py-1 text-[10px]"
            onClick={closeProject}
            title="Back to projects"
          >
            Back
          </button>
          <button
            className="lc-btn px-2 py-1 text-[11px] disabled:opacity-50"
            onClick={async () => {
              setDedupeStatus(null);
              const result = await dedupeMedia();
              if (!result) return;
              setDedupeStatus(
                result.dedupedAssets > 0
                  ? `Removed ${result.dedupedAssets} duplicates`
                  : 'No duplicate assets found',
              );
            }}
            disabled={isLoading}
            title="Remove duplicate media assets and relink timeline references"
          >
            Clean
          </button>
          <button
            className="lc-btn lc-btn-primary px-2 py-1 text-[11px] disabled:opacity-50"
            onClick={handleImport}
            disabled={isLoading}
            title="Link media from its original location without copying it into the project"
          >
            {isLoading ? 'Linking…' : '+ Link'}
          </button>
        </div>
      </div>

      <div className="space-y-1 border-b border-zinc-700 bg-zinc-900/50 p-2">
        {dedupeStatus && (
          <div className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200">
            {dedupeStatus}
          </div>
        )}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search media..."
          className="lc-input"
        />
        <div className="flex items-center gap-1">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as 'all' | 'video' | 'audio' | 'image')}
            className="lc-select flex-1"
          >
            <option value="all">All Types</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="image">Image</option>
          </select>
          <button
            className={`lc-btn px-2 py-1 text-[11px] ${viewMode === 'list' ? 'lc-btn-primary' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            List
          </button>
          <button
            className={`lc-btn px-2 py-1 text-[11px] ${viewMode === 'grid' ? 'lc-btn-primary' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            Grid
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-1">
        {isDragOver && (
          <div className="mb-1 flex items-center justify-center rounded border-2 border-dashed border-blue-500/50 bg-blue-500/10 p-6 text-sm text-blue-300">
            Drop files to import
          </div>
        )}
        {mediaAssets.length === 0 && !isDragOver ? (
          <div className="p-3 text-center text-sm text-zinc-500">
            No media imported yet.
            <br />
            <button className="mt-2 text-blue-400 hover:text-blue-300" onClick={handleImport}>
              Link files
            </button>
            <p className="mt-1 text-[10px] text-zinc-600">or drag &amp; drop files here if native paths are available</p>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="p-3 text-center text-xs text-zinc-500">No media matches this filter.</div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-2 gap-2 p-1">
            {filteredAssets.map((asset) => (
              <MediaItem
                key={asset.id}
                asset={asset}
                mode="grid"
                onSelect={() => {
                  setSelectedAsset(asset.id);
                  setSourceAsset(asset);
                }}
                isSelected={selectedAsset === asset.id}
              />
            ))}
          </div>
        ) : (
          filteredAssets.map((asset) => (
            <MediaItem
              key={asset.id}
              asset={asset}
              mode="list"
              onSelect={() => {
                setSelectedAsset(asset.id);
                setSourceAsset(asset);
              }}
              isSelected={selectedAsset === asset.id}
            />
          ))
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        warning={confirm?.warning}
        confirmLabel={confirm?.actionLabel ?? 'Confirm'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          const current = confirm;
          setConfirm(null);
          try {
            await deleteMedia(current.id);
            if (selectedAsset === current.id) {
              setSelectedAsset(null);
              setSourceAsset(null);
            }
          } catch {
            // store already captures error
          }
        }}
      />
    </aside>
  );
}
