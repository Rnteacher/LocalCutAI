import { useEffect, useState } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ProjectSettingsDialog } from './ProjectSettingsDialog.js';
import { UIButton, UIInput } from './ui.js';

export function ProjectsScreen() {
  const { projects, fetchProjects, createProject, openProject, deleteProject } = useProjectStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateSettings, setShowCreateSettings] = useState(false);
  const [name, setName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  return (
    <div className="flex flex-1 flex-col bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-300">
            Projects
          </h2>
          <p className="text-[11px] text-zinc-500">Create, browse and continue edit sessions</p>
        </div>
        <UIButton variant="primary" onClick={() => setShowCreate((v) => !v)}>
          + New Project
        </UIButton>
      </div>

      {showCreate && (
        <div className="border-b border-zinc-800 bg-zinc-900/70 px-5 py-4">
          <div className="lc-card p-3">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">
              New Project
            </div>
            <div className="flex items-center gap-2">
              <UIInput
                className="max-w-md"
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key !== 'Enter') return;
                  if (!name.trim()) return;
                  setShowCreateSettings(true);
                }}
              />
              <UIButton
                variant="primary"
                onClick={() => {
                  if (!name.trim()) return;
                  setShowCreateSettings(true);
                }}
              >
                Continue
              </UIButton>
              <UIButton onClick={() => setShowCreate(false)}>Cancel</UIButton>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
        {projects.length === 0 ? (
          <div className="lc-card p-8 text-center text-sm text-zinc-500">No projects yet.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <div key={p.id} className="lc-card p-3 transition-colors hover:border-zinc-500">
                <button
                  className="w-full text-left"
                  onClick={() => openProject(p.id)}
                  title="Open project"
                >
                  <div className="truncate text-sm font-semibold text-zinc-200">{p.name}</div>
                  <div className="text-[11px] text-zinc-500">
                    {new Date(p.createdAt).toLocaleString()}
                  </div>
                </button>
                <div className="mt-2 flex justify-end">
                  <UIButton
                    variant="danger"
                    onClick={() => setDeleteTarget({ id: p.id, name: p.name })}
                  >
                    Delete
                  </UIButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete project?"
        message={deleteTarget ? `Delete \"${deleteTarget.name}\"? This cannot be undone.` : ''}
        confirmLabel="Delete Project"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          const id = deleteTarget.id;
          setDeleteTarget(null);
          await deleteProject(id);
        }}
      />

      <ProjectSettingsDialog
        open={showCreateSettings}
        title="New Project Settings"
        initial={{
          defaultFrameRate: { num: 24, den: 1 },
          defaultResolution: { width: 1920, height: 1080 },
          audioSampleRate: 48000,
          aspectRatio: '16:9',
          audioChannels: 2,
        }}
        onCancel={() => setShowCreateSettings(false)}
        onSave={async (settings) => {
          if (!name.trim()) return;
          await createProject(name.trim(), settings as Record<string, unknown>);
          setShowCreateSettings(false);
          setName('');
          setShowCreate(false);
        }}
      />
    </div>
  );
}
