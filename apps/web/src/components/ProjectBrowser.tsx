import { useEffect, useState } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import type { ApiMediaAsset } from '../lib/api.js';

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
}: {
  asset: ApiMediaAsset;
  onSelect: (asset: ApiMediaAsset) => void;
  isSelected: boolean;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
        isSelected
          ? 'bg-blue-500/20 text-blue-200'
          : 'text-zinc-300 hover:bg-zinc-700/50'
      }`}
      onClick={() => onSelect(asset)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-localcut-asset', JSON.stringify(asset));
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <MediaIcon type={asset.type} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{asset.name}</div>
        <div className="flex gap-2 text-[10px] text-zinc-500">
          {asset.duration != null && <span>{formatDuration(asset.duration)}</span>}
          {asset.resolution && (
            <span>{asset.resolution.width}×{asset.resolution.height}</span>
          )}
          <span>{formatFileSize(asset.fileSize)}</span>
        </div>
      </div>
    </button>
  );
}

export function ProjectBrowser() {
  const {
    currentProject,
    projects,
    mediaAssets,
    fetchProjects,
    createProject,
    openProject,
    importMedia,
  } = useProjectStore();

  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleCreate = async () => {
    if (newProjectName.trim()) {
      await createProject(newProjectName.trim());
      setNewProjectName('');
      setShowCreateDialog(false);
    }
  };

  const handleImport = () => {
    // In a local-first app, we prompt for file paths.
    // For browser we'll use a simple prompt for now.
    const paths = prompt('Enter file path(s) separated by commas:');
    if (paths) {
      const filePaths = paths.split(',').map((p) => p.trim()).filter(Boolean);
      if (filePaths.length > 0) importMedia(filePaths);
    }
  };

  // Show project list if no project is open
  if (!currentProject) {
    return (
      <aside className="flex w-64 flex-col border-r border-zinc-700 bg-zinc-800/50">
        <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Projects
          </span>
          <button
            className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-500"
            onClick={() => setShowCreateDialog(true)}
          >
            + New
          </button>
        </div>

        {showCreateDialog && (
          <div className="border-b border-zinc-700 p-3">
            <input
              className="mb-2 w-full rounded bg-zinc-700 px-2 py-1 text-sm text-white placeholder-zinc-400 outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Project name..."
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <div className="flex gap-2">
              <button
                className="flex-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
                onClick={handleCreate}
              >
                Create
              </button>
              <button
                className="flex-1 rounded bg-zinc-600 px-2 py-1 text-xs text-white hover:bg-zinc-500"
                onClick={() => setShowCreateDialog(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto p-2">
          {projects.length === 0 ? (
            <div className="p-3 text-center text-sm text-zinc-500">
              No projects yet.
            </div>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700/50"
                onClick={() => openProject(p.id)}
              >
                <span className="text-blue-400">📁</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="text-[10px] text-zinc-500">
                    {new Date(p.createdAt).toLocaleDateString()}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>
    );
  }

  // Show media browser when project is open
  return (
    <aside className="flex w-64 flex-col border-r border-zinc-700 bg-zinc-800/50">
      <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Media
        </span>
        <button
          className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-500"
          onClick={handleImport}
        >
          + Import
        </button>
      </div>

      <div className="flex-1 overflow-auto p-1">
        {mediaAssets.length === 0 ? (
          <div className="p-3 text-center text-sm text-zinc-500">
            No media imported yet.
            <br />
            <button
              className="mt-2 text-blue-400 hover:text-blue-300"
              onClick={handleImport}
            >
              Import files
            </button>
          </div>
        ) : (
          mediaAssets.map((asset) => (
            <MediaItem
              key={asset.id}
              asset={asset}
              onSelect={() => setSelectedAsset(asset.id)}
              isSelected={selectedAsset === asset.id}
            />
          ))
        )}
      </div>
    </aside>
  );
}
