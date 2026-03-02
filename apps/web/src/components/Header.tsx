import { useState } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { ExportDialog } from './ExportDialog.js';

export function Header() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const sequences = useProjectStore((s) => s.sequences);
  const [showExport, setShowExport] = useState(false);

  const firstSequenceId = sequences[0]?.id;

  return (
    <>
      <header className="flex h-10 items-center border-b border-zinc-700 bg-zinc-800 px-4">
        <h1 className="text-sm font-bold tracking-wide text-blue-400">LocalCut</h1>
        <span className="ml-2 text-xs text-zinc-500">v0.1.0</span>
        {currentProject && (
          <>
            <span className="mx-3 text-zinc-600">|</span>
            <span className="text-sm text-zinc-300">{currentProject.name}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {currentProject && firstSequenceId && (
            <button
              onClick={() => setShowExport(true)}
              className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500"
            >
              Export
            </button>
          )}
          {currentProject && (
            <span className="text-xs text-zinc-500">
              {currentProject.projectDir}
            </span>
          )}
        </div>
      </header>

      {showExport && firstSequenceId && (
        <ExportDialog
          sequenceId={firstSequenceId}
          onClose={() => setShowExport(false)}
        />
      )}
    </>
  );
}
