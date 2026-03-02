/**
 * Selection state store — tracks which clips, tracks, and
 * elements are currently selected in the UI.
 */

import { create } from 'zustand';

interface SelectionState {
  selectedClipIds: Set<string>;
  selectedTrackId: string | null;
  activePanel: 'project-browser' | 'source-monitor' | 'program-monitor' | 'timeline' | 'inspector' | null;

  // Actions
  selectClip: (clipId: string, addToSelection?: boolean) => void;
  deselectClip: (clipId: string) => void;
  clearClipSelection: () => void;
  selectTrack: (trackId: string | null) => void;
  setActivePanel: (panel: SelectionState['activePanel']) => void;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selectedClipIds: new Set<string>(),
  selectedTrackId: null,
  activePanel: null,

  selectClip: (clipId, addToSelection = false) => {
    const { selectedClipIds } = get();
    if (addToSelection) {
      const next = new Set(selectedClipIds);
      if (next.has(clipId)) {
        next.delete(clipId);
      } else {
        next.add(clipId);
      }
      set({ selectedClipIds: next });
    } else {
      set({ selectedClipIds: new Set([clipId]) });
    }
  },

  deselectClip: (clipId) => {
    const { selectedClipIds } = get();
    const next = new Set(selectedClipIds);
    next.delete(clipId);
    set({ selectedClipIds: next });
  },

  clearClipSelection: () => set({ selectedClipIds: new Set() }),

  selectTrack: (trackId) => set({ selectedTrackId: trackId }),

  setActivePanel: (panel) => set({ activePanel: panel }),
}));
