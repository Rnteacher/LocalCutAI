/**
 * Zustand store for project-level state management.
 */

import { create } from 'zustand';
import { api } from '../lib/api.js';
import type { ApiProject, ApiMediaAsset, ApiSequence } from '../lib/api.js';

interface ProjectState {
  // Data
  projects: ApiProject[];
  currentProject: ApiProject | null;
  mediaAssets: ApiMediaAsset[];
  sequences: ApiSequence[];

  // UI
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchProjects: () => Promise<void>;
  createProject: (name: string) => Promise<ApiProject>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  deleteProject: (id: string) => Promise<void>;
  importMedia: (filePaths: string[]) => Promise<void>;
  deleteMedia: (assetId: string) => Promise<void>;
  setError: (error: string | null) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  mediaAssets: [],
  sequences: [],
  isLoading: false,
  error: null,

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const projects = await api.projects.list();
      set({ projects, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  createProject: async (name: string) => {
    set({ isLoading: true, error: null });
    try {
      const project = await api.projects.create(name);
      set((s) => ({ projects: [...s.projects, project], isLoading: false }));
      // Auto-open the new project
      await get().openProject(project.id);
      return project;
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  openProject: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const project = await api.projects.get(id);
      const mediaAssets = await api.media.list(id);
      set({
        currentProject: project,
        mediaAssets,
        sequences: project.sequences || [],
        isLoading: false,
      });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  closeProject: () => {
    set({
      currentProject: null,
      mediaAssets: [],
      sequences: [],
    });
  },

  deleteProject: async (id: string) => {
    try {
      await api.projects.delete(id);
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        currentProject: s.currentProject?.id === id ? null : s.currentProject,
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  importMedia: async (filePaths: string[]) => {
    const project = get().currentProject;
    if (!project) return;

    set({ isLoading: true, error: null });
    try {
      const result = await api.media.import(project.id, filePaths);
      set((s) => ({
        mediaAssets: [...s.mediaAssets, ...result.imported],
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  deleteMedia: async (assetId: string) => {
    const project = get().currentProject;
    if (!project) return;

    try {
      await api.media.delete(project.id, assetId);
      set((s) => ({
        mediaAssets: s.mediaAssets.filter((a) => a.id !== assetId),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setError: (error: string | null) => set({ error }),
}));
