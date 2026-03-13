/**
 * Selection state store — tracks which clips, tracks, and
 * elements are currently selected in the UI.
 */

import { create } from 'zustand';
import type { ApiMediaAsset } from '../lib/api.js';

interface SelectionState {
  rendererMode: 'auto' | 'canvas2d' | 'webgl2';
  selectedClipIds: Set<string>;
  selectedClipId: string | null;
  activeMaskClipId: string | null;
  activeMaskId: string | null;
  selectedTrackId: string | null;
  timelineTool: 'select' | 'razor';
  rippleMode: boolean;
  linkedSelection: boolean;
  linkedScale: boolean;
  autoKeyframeEnabled: boolean;
  activePanel:
    | 'project-browser'
    | 'source-monitor'
    | 'program-monitor'
    | 'timeline'
    | 'inspector'
    | null;

  /** Media asset currently loaded in the Source Monitor */
  sourceAsset: ApiMediaAsset | null;

  /** Source monitor in/out times (seconds) for three-point editing */
  sourceInTime: number | null;
  sourceOutTime: number | null;
  sourceInsertMode: 'insert' | 'overwrite';
  targetVideoTrackId: string | null;
  targetAudioTrackId: string | null;

  // Actions
  selectClip: (clipId: string, addToSelection?: boolean) => void;
  deselectClip: (clipId: string) => void;
  clearClipSelection: () => void;
  setActiveMaskSelection: (clipId: string | null, maskId: string | null) => void;
  setRendererMode: (mode: SelectionState['rendererMode']) => void;
  selectTrack: (trackId: string | null) => void;
  setActivePanel: (panel: SelectionState['activePanel']) => void;
  setTimelineTool: (tool: SelectionState['timelineTool']) => void;
  setRippleMode: (enabled: boolean) => void;
  setLinkedSelection: (enabled: boolean) => void;
  setLinkedScale: (enabled: boolean) => void;
  setAutoKeyframeEnabled: (enabled: boolean) => void;
  setSourceAsset: (asset: ApiMediaAsset | null) => void;
  setSourceInTime: (time: number | null) => void;
  setSourceOutTime: (time: number | null) => void;
  setSourceInsertMode: (mode: SelectionState['sourceInsertMode']) => void;
  setTargetVideoTrackId: (trackId: string | null) => void;
  setTargetAudioTrackId: (trackId: string | null) => void;
  clearSourceInOut: () => void;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  rendererMode: 'auto',
  selectedClipIds: new Set<string>(),
  selectedClipId: null,
  activeMaskClipId: null,
  activeMaskId: null,
  selectedTrackId: null,
  timelineTool: 'select',
  rippleMode: false,
  linkedSelection: true,
  linkedScale: true,
  autoKeyframeEnabled: false,
  activePanel: null,
  sourceAsset: null,
  sourceInTime: null,
  sourceOutTime: null,
  sourceInsertMode: 'overwrite',
  targetVideoTrackId: null,
  targetAudioTrackId: null,

  selectClip: (clipId, addToSelection = false) => {
    const { selectedClipIds } = get();
    if (addToSelection) {
      const next = new Set(selectedClipIds);
      if (next.has(clipId)) {
        next.delete(clipId);
      } else {
        next.add(clipId);
      }
      const selectedClipId = next.size === 1 ? Array.from(next)[0] : null;
      set((state) => ({
        selectedClipIds: next,
        selectedClipId,
        activeMaskClipId:
          selectedClipId == null || state.activeMaskClipId === selectedClipId
            ? state.activeMaskClipId
            : null,
        activeMaskId:
          selectedClipId == null || state.activeMaskClipId === selectedClipId ? state.activeMaskId : null,
      }));
    } else {
      set((state) => ({
        selectedClipIds: new Set([clipId]),
        selectedClipId: clipId,
        activeMaskClipId: state.activeMaskClipId === clipId ? state.activeMaskClipId : null,
        activeMaskId: state.activeMaskClipId === clipId ? state.activeMaskId : null,
      }));
    }
  },

  deselectClip: (clipId) => {
    const { selectedClipIds } = get();
    const next = new Set(selectedClipIds);
    next.delete(clipId);
    const selectedClipId = next.size === 1 ? Array.from(next)[0] : null;
    set((state) => ({
      selectedClipIds: next,
      selectedClipId,
      activeMaskClipId:
        selectedClipId == null || state.activeMaskClipId === selectedClipId ? state.activeMaskClipId : null,
      activeMaskId:
        selectedClipId == null || state.activeMaskClipId === selectedClipId ? state.activeMaskId : null,
    }));
  },

  clearClipSelection: () =>
    set({
      selectedClipIds: new Set(),
      selectedClipId: null,
      activeMaskClipId: null,
      activeMaskId: null,
    }),

  setActiveMaskSelection: (clipId, maskId) =>
    set((state) => {
      if (state.activeMaskClipId === clipId && state.activeMaskId === maskId) {
        return state;
      }
      return { activeMaskClipId: clipId, activeMaskId: maskId };
    }),

  setRendererMode: (mode) => set({ rendererMode: mode }),

  selectTrack: (trackId) => set({ selectedTrackId: trackId }),

  setActivePanel: (panel) => set({ activePanel: panel }),

  setTimelineTool: (tool) => set({ timelineTool: tool }),

  setRippleMode: (enabled) => set({ rippleMode: enabled }),

  setLinkedSelection: (enabled) => set({ linkedSelection: enabled }),

  setLinkedScale: (enabled) => set({ linkedScale: enabled }),

  setAutoKeyframeEnabled: (enabled) => set({ autoKeyframeEnabled: enabled }),

  setSourceAsset: (asset) => set({ sourceAsset: asset, sourceInTime: null, sourceOutTime: null }),

  setSourceInTime: (time) => set({ sourceInTime: time }),

  setSourceOutTime: (time) => set({ sourceOutTime: time }),

  setSourceInsertMode: (mode) => set({ sourceInsertMode: mode }),

  setTargetVideoTrackId: (trackId) => set({ targetVideoTrackId: trackId }),

  setTargetAudioTrackId: (trackId) => set({ targetAudioTrackId: trackId }),

  clearSourceInOut: () => set({ sourceInTime: null, sourceOutTime: null }),
}));
