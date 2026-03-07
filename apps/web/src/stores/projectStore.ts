/**
 * Zustand store for project-level state management.
 *
 * Milestone 2 additions:
 *   - Clip transform/opacity/speed fields
 *   - Undo/redo history stack (_history / _future)
 *   - splitClipAtPlayhead, updateClipProperties, rippleTrimClip, rippleDeleteClips
 *   - trimClip now adjusts sourceInFrame/sourceOutFrame properly
 */

import { create } from 'zustand';
import { api } from '../lib/api.js';
import type { ApiProject, ApiMediaAsset, ApiSequence } from '../lib/api.js';

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/** Shape of a clip in the sequence JSON data */
export interface TimelineClipData {
  id: string;
  name: string;
  type: string;
  startFrame: number;
  durationFrames: number;
  mediaAssetId: string | null;
  sourceInFrame?: number;
  sourceOutFrame?: number;
  // Transform (all optional ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â defaults applied at render time)
  opacity?: number; // default 1
  positionX?: number; // default 0 (px offset from center)
  positionY?: number; // default 0
  scaleX?: number; // default 1
  scaleY?: number; // default 1
  rotation?: number; // default 0 (degrees)
  speed?: number; // default 1
  preservePitch?: boolean; // default true
  audioGainDb?: number; // default 0
  gain?: number; // default 1 (linear)
  pan?: number; // default 0 (-1..1)
  audioVolume?: number; // default 1
  audioPan?: number; // default 0 (-1..1)
  audioEqLow?: number; // dB
  audioEqMid?: number; // dB
  audioEqHigh?: number; // dB
  audioEq63?: number; // dB
  audioEq125?: number; // dB
  audioEq250?: number; // dB
  audioEq500?: number; // dB
  audioEq1k?: number; // dB
  audioEq2k?: number; // dB
  audioEq4k?: number; // dB
  audioEq8k?: number; // dB
  brightness?: number; // default 1
  contrast?: number; // default 1
  saturation?: number; // default 1
  hue?: number; // default 0 (deg)
  vignette?: number; // default 0 (-1..1, bright..dark)
  linkedClipId?: string;
}

/** Shape of a track in the sequence JSON data */
export interface TimelineTrackData {
  id: string;
  sequenceId: string;
  name: string;
  type: 'video' | 'audio';
  index: number;
  locked: boolean;
  syncLocked?: boolean;
  visible: boolean;
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  channelMode?: 'stereo' | 'mono';
  channelMap?: 'L+R' | 'L' | 'R';
  clips: TimelineClipData[];
}

/** Shape of the sequence.data JSON */
interface SequenceData {
  tracks: TimelineTrackData[];
  frameRate?: { num: number; den: number };
}

// ---------------------------------------------------------------------------
// History (undo/redo)
// ---------------------------------------------------------------------------

const MAX_HISTORY = 50;
let clipPropsMutationToken = 0;
const sequenceUpdateQueues = new Map<string, Promise<ApiSequence>>();
type SequenceUpdatePayload = Parameters<typeof api.sequences.update>[1];

async function enqueueSequenceUpdate(
  sequenceId: string,
  payload: SequenceUpdatePayload,
): Promise<ApiSequence> {
  const prev = sequenceUpdateQueues.get(sequenceId) ?? Promise.resolve(undefined as unknown as ApiSequence);
  const next = prev
    .catch(() => undefined as unknown as ApiSequence)
    .then(() => api.sequences.update(sequenceId, payload));

  sequenceUpdateQueues.set(sequenceId, next);

  try {
    return await next;
  } finally {
    if (sequenceUpdateQueues.get(sequenceId) === next) {
      sequenceUpdateQueues.delete(sequenceId);
    }
  }
}

interface HistoryEntry {
  data: SequenceData;
  seqId: string;
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

interface ProjectState {
  // Data
  projects: ApiProject[];
  currentProject: ApiProject | null;
  mediaAssets: ApiMediaAsset[];
  sequences: ApiSequence[];

  // UI
  isLoading: boolean;
  error: string | null;

  // History (undo/redo)
  _history: HistoryEntry[];
  _future: HistoryEntry[];
  _pushHistory: () => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Actions
  fetchProjects: () => Promise<void>;
  createProject: (name: string, settings?: Record<string, unknown>) => Promise<ApiProject>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  deleteProject: (id: string) => Promise<void>;
  updateProjectSettings: (settings: {
    defaultFrameRate?: { num: number; den: number };
    defaultResolution?: { width: number; height: number };
    audioSampleRate?: number;
    aspectRatio?: string;
    audioChannels?: number;
  }) => Promise<void>;
  importMedia: (filePaths: string[]) => Promise<void>;
  uploadMedia: (files: FileList | File[]) => Promise<void>;
  deleteMedia: (assetId: string) => Promise<void>;
  setError: (error: string | null) => void;

  // Timeline editing
  addClipToTrack: (params: {
    trackId: string;
    asset: ApiMediaAsset;
    startFrame: number;
    sourceInFrame?: number;
    sourceOutFrame?: number;
    insertMode?: 'overwrite' | 'ripple';
    audioOnly?: boolean;
  }) => Promise<void>;
  addTrack: (type: 'video' | 'audio') => Promise<string | null>;
  removeClips: (clipIds: string[]) => Promise<void>;
  moveClip: (
    clipId: string,
    newTrackId: string,
    newStartFrame: number,
    options?: { unlink?: boolean },
  ) => Promise<void>;
  trimClip: (
    clipId: string,
    newStartFrame: number,
    newDurationFrames: number,
    options?: { unlink?: boolean },
  ) => Promise<void>;

  // Milestone 2 actions
  splitClipAtPlayhead: (clipId: string, frame: number) => Promise<void>;
  updateClipProperties: (clipId: string, props: Partial<TimelineClipData>) => Promise<void>;
  rippleTrimClip: (
    clipId: string,
    newStartFrame: number,
    newDurationFrames: number,
    options?: { unlink?: boolean },
  ) => Promise<void>;
  rippleDeleteClips: (clipIds: string[]) => Promise<void>;
  liftRangeByInOut: (
    inFrame: number,
    outFrame: number,
    options?: {
      selectedClipIds?: string[];
      targetTrackIds?: string[];
      includeLinked?: boolean;
      useSyncLock?: boolean;
    },
  ) => Promise<void>;
  extractRangeByInOut: (
    inFrame: number,
    outFrame: number,
    options?: {
      selectedClipIds?: string[];
      targetTrackIds?: string[];
      includeLinked?: boolean;
      useSyncLock?: boolean;
    },
  ) => Promise<void>;

  // Milestone 3 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â track management
  updateTrack: (
    trackId: string,
    props: Partial<
      Pick<
        TimelineTrackData,
        | 'muted'
        | 'solo'
        | 'locked'
        | 'syncLocked'
        | 'volume'
        | 'pan'
        | 'visible'
        | 'channelMode'
        | 'channelMap'
      >
    >,
  ) => Promise<void>;
  isTrackLocked: (trackId: string) => boolean;
  unlinkSelectedClips: (clipIds: string[]) => Promise<void>;
  relinkSelectedClips: (clipIds: string[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function getSeqData(seq: ApiSequence): SequenceData {
  const raw = seq.data as unknown;
  if (!raw || typeof raw !== 'object') {
    return { tracks: [] };
  }

  const data = raw as { tracks?: unknown; frameRate?: { num: number; den: number } };
  const tracks = Array.isArray(data.tracks) ? (data.tracks as TimelineTrackData[]) : [];
  return {
    ...data,
    tracks,
  };
}

function cloneClip(clip: TimelineClipData): TimelineClipData {
  return { ...clip };
}

function overwriteTrackWithClip(
  clips: TimelineClipData[],
  incoming: TimelineClipData,
  excludeClipId?: string,
): TimelineClipData[] {
  const inStart = incoming.startFrame;
  const inEnd = incoming.startFrame + incoming.durationFrames;

  const result: TimelineClipData[] = [];
  for (const clip of clips) {
    if (clip.id === excludeClipId) continue;

    const start = clip.startFrame;
    const end = clip.startFrame + clip.durationFrames;

    if (end <= inStart || start >= inEnd) {
      result.push(cloneClip(clip));
      continue;
    }

    const sourceIn = clip.sourceInFrame ?? 0;

    if (start < inStart) {
      const leftDuration = inStart - start;
      if (leftDuration > 0) {
        result.push({
          ...cloneClip(clip),
          durationFrames: leftDuration,
          sourceOutFrame: sourceIn + leftDuration,
        });
      }
    }

    if (end > inEnd) {
      const rightStart = inEnd;
      const rightDuration = end - inEnd;
      if (rightDuration > 0) {
        const rightOffset = rightStart - start;
        const rightSourceIn = sourceIn + rightOffset;
        result.push({
          ...cloneClip(clip),
          id: generateId(),
          startFrame: rightStart,
          durationFrames: rightDuration,
          sourceInFrame: rightSourceIn,
          sourceOutFrame: rightSourceIn + rightDuration,
        });
      }
    }
  }

  result.push(incoming);
  result.sort((a, b) => a.startFrame - b.startFrame);
  return result;
}

function rippleInsertTrackWithClip(
  clips: TimelineClipData[],
  incoming: TimelineClipData,
): TimelineClipData[] {
  const insertionStart = incoming.startFrame;
  const insertionDur = Math.max(1, incoming.durationFrames);
  const result: TimelineClipData[] = [];

  for (const clip of clips) {
    const start = clip.startFrame;
    const end = clip.startFrame + clip.durationFrames;
    const sourceIn = clip.sourceInFrame ?? 0;

    if (end <= insertionStart) {
      result.push(cloneClip(clip));
      continue;
    }

    if (start >= insertionStart) {
      result.push({ ...cloneClip(clip), startFrame: start + insertionDur });
      continue;
    }

    const leftDur = insertionStart - start;
    if (leftDur > 0) {
      result.push({
        ...cloneClip(clip),
        durationFrames: leftDur,
        sourceOutFrame: sourceIn + leftDur,
      });
    }

    const rightDur = end - insertionStart;
    if (rightDur > 0) {
      const rightSourceIn = sourceIn + leftDur;
      result.push({
        ...cloneClip(clip),
        id: generateId(),
        startFrame: insertionStart + insertionDur,
        durationFrames: rightDur,
        sourceInFrame: rightSourceIn,
        sourceOutFrame: rightSourceIn + rightDur,
      });
    }
  }

  result.push(incoming);
  result.sort((a, b) => a.startFrame - b.startFrame);
  return result;
}

function assetTypeToTrackType(assetType: ApiMediaAsset['type']): TimelineTrackData['type'] {
  return assetType === 'audio' ? 'audio' : 'video';
}

function clipTypeToTrackType(clipType: TimelineClipData['type']): TimelineTrackData['type'] {
  return clipType === 'audio' ? 'audio' : 'video';
}

function parseTrackNumber(name: string, prefix: 'V' | 'A'): number | null {
  const m = name
    .trim()
    .toUpperCase()
    .match(new RegExp(`^${prefix}(\\d+)$`));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function nextTrackName(tracks: TimelineTrackData[], type: 'video' | 'audio'): string {
  const prefix = type === 'video' ? 'V' : 'A';
  const nums = tracks
    .filter((t) => t.type === type)
    .map((t) => parseTrackNumber(t.name, prefix))
    .filter((n): n is number => n != null);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}${next}`;
}

function normalizeTrackIndices(tracks: TimelineTrackData[]): TimelineTrackData[] {
  return tracks.map((t, i) => ({ ...t, index: i }));
}

function ensureBaseTracks(
  data: SequenceData,
  seqId: string,
): { data: SequenceData; changed: boolean } {
  const tracks: TimelineTrackData[] = [];
  for (const t of data.tracks) {
    if (!t || (t.type !== 'video' && t.type !== 'audio')) continue;
    tracks.push({
      ...t,
      sequenceId: t.sequenceId || seqId,
      locked: t.locked ?? false,
      syncLocked: t.syncLocked ?? true,
      visible: t.visible ?? true,
      muted: t.muted ?? false,
      solo: t.solo ?? false,
      volume: t.volume ?? 1,
      pan: t.pan ?? 0,
      channelMode: t.channelMode ?? 'stereo',
      channelMap: t.channelMap ?? 'L+R',
      clips: Array.isArray(t.clips) ? t.clips : [],
    });
  }
  let changed = false;

  const hasV1 = tracks.some((t) => t.type === 'video' && t.name.trim().toUpperCase() === 'V1');
  const hasV2 = tracks.some((t) => t.type === 'video' && t.name.trim().toUpperCase() === 'V2');
  const hasA1 = tracks.some((t) => t.type === 'audio' && t.name.trim().toUpperCase() === 'A1');
  const hasA2 = tracks.some((t) => t.type === 'audio' && t.name.trim().toUpperCase() === 'A2');

  const makeTrack = (name: string, type: 'video' | 'audio'): TimelineTrackData => ({
    id: generateId(),
    sequenceId: seqId,
    name,
    type,
    index: 0,
    locked: false,
    syncLocked: true,
    visible: true,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    channelMode: 'stereo',
    channelMap: 'L+R',
    clips: [],
  });

  if (!hasV2) {
    tracks.unshift(makeTrack('V2', 'video'));
    changed = true;
  }
  if (!hasV1) {
    const firstAudio = tracks.findIndex((t) => t.type === 'audio');
    const insertAt = firstAudio === -1 ? tracks.length : firstAudio;
    tracks.splice(insertAt, 0, makeTrack('V1', 'video'));
    changed = true;
  }
  if (!hasA1) {
    tracks.push(makeTrack('A1', 'audio'));
    changed = true;
  }
  if (!hasA2) {
    tracks.push(makeTrack('A2', 'audio'));
    changed = true;
  }

  const normalized = normalizeTrackIndices(tracks);
  return { data: { ...data, tracks: normalized }, changed };
}

function findPairedAudioTrackId(tracks: TimelineTrackData[], videoTrackId: string): string | null {
  const videoTracks = tracks.filter((t) => t.type === 'video');
  const audioTracks = tracks.filter((t) => t.type === 'audio' && !t.locked);
  if (audioTracks.length === 0) return null;

  const video = videoTracks.find((t) => t.id === videoTrackId);
  if (!video) return audioTracks[0].id;

  const vNum = parseTrackNumber(video.name, 'V');
  if (vNum != null) {
    const named = audioTracks.find((t) => parseTrackNumber(t.name, 'A') === vNum);
    if (named) return named.id;
  }

  const sortedV = [...videoTracks].sort(
    (a, b) => (parseTrackNumber(a.name, 'V') ?? 999) - (parseTrackNumber(b.name, 'V') ?? 999),
  );
  const sortedA = [...audioTracks].sort(
    (a, b) => (parseTrackNumber(a.name, 'A') ?? 999) - (parseTrackNumber(b.name, 'A') ?? 999),
  );
  const vIdx = Math.max(
    0,
    sortedV.findIndex((t) => t.id === videoTrackId),
  );
  const mapped = sortedA[Math.min(vIdx, sortedA.length - 1)];
  return mapped?.id ?? sortedA[0]?.id ?? null;
}

function computeTrimResult(
  clip: TimelineClipData,
  newStartFrame: number,
  newDurationFrames: number,
): {
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  oldEnd: number;
  newEnd: number;
} {
  const oldStartFrame = clip.startFrame;
  const oldEndFrame = clip.startFrame + clip.durationFrames;
  const sourceIn = clip.sourceInFrame ?? 0;
  const minStartFrame = oldStartFrame - sourceIn;
  const requestedStartFrame = Math.max(0, newStartFrame);
  const clampedStartFrame = Math.max(minStartFrame, requestedStartFrame);
  const isLeftTrim = newStartFrame !== oldStartFrame;

  const requestedDuration = Math.max(1, newDurationFrames);
  const clampedDuration = isLeftTrim
    ? Math.max(1, oldEndFrame - clampedStartFrame)
    : requestedDuration;

  const leftDelta = clampedStartFrame - oldStartFrame;
  const newSourceIn = sourceIn + leftDelta;
  const newSourceOut = newSourceIn + clampedDuration;

  return {
    startFrame: clampedStartFrame,
    durationFrames: clampedDuration,
    sourceInFrame: newSourceIn,
    sourceOutFrame: newSourceOut,
    oldEnd: oldEndFrame,
    newEnd: clampedStartFrame + clampedDuration,
  };
}

function cutClipByRange(
  clip: TimelineClipData,
  rangeIn: number,
  rangeOut: number,
  mode: 'lift' | 'extract',
): TimelineClipData[] {
  const clipStart = clip.startFrame;
  const clipEnd = clip.startFrame + clip.durationFrames;
  const sourceIn = clip.sourceInFrame ?? 0;

  if (clipEnd <= rangeIn || clipStart >= rangeOut) {
    if (mode === 'extract' && clipStart >= rangeOut) {
      const shift = rangeOut - rangeIn;
      return [{ ...clip, startFrame: Math.max(0, clipStart - shift) }];
    }
    return [{ ...clip }];
  }

  const pieces: TimelineClipData[] = [];

  if (clipStart < rangeIn) {
    const leftDur = Math.max(0, rangeIn - clipStart);
    if (leftDur > 0) {
      pieces.push({
        ...clip,
        durationFrames: leftDur,
        sourceInFrame: sourceIn,
        sourceOutFrame: sourceIn + leftDur,
      });
    }
  }

  if (clipEnd > rangeOut) {
    const rightDur = Math.max(0, clipEnd - rangeOut);
    if (rightDur > 0) {
      const rightSourceIn = sourceIn + (rangeOut - clipStart);
      const rightStart = mode === 'extract' ? rangeIn : rangeOut;
      pieces.push({
        ...clip,
        id: generateId(),
        startFrame: Math.max(0, rightStart),
        durationFrames: rightDur,
        sourceInFrame: rightSourceIn,
        sourceOutFrame: rightSourceIn + rightDur,
      });
    }
  }

  return pieces;
}

function resolveAffectedTrackIds(
  tracks: TimelineTrackData[],
  options?: {
    selectedClipIds?: string[];
    targetTrackIds?: string[];
    includeLinked?: boolean;
    useSyncLock?: boolean;
  },
): Set<string> {
  const selected = new Set(options?.selectedClipIds ?? []);
  const targeted = new Set(options?.targetTrackIds ?? []);

  if (selected.size > 0) {
    const affected = new Set<string>();
    for (const t of tracks) {
      for (const c of t.clips) {
        if (selected.has(c.id)) {
          affected.add(t.id);
          if (options?.includeLinked && c.linkedClipId) {
            for (const lt of tracks) {
              if (lt.clips.some((x) => x.id === c.linkedClipId)) {
                affected.add(lt.id);
                break;
              }
            }
          }
        }
      }
    }
    if (affected.size > 0) {
      if (options?.useSyncLock !== false) {
        const shouldSync = tracks.some((t) => affected.has(t.id) && t.syncLocked !== false);
        if (shouldSync) {
          for (const t of tracks) {
            if (!t.locked && t.syncLocked !== false) affected.add(t.id);
          }
        }
      }
      return affected;
    }
  }

  if (targeted.size > 0) {
    const affected = new Set<string>();
    for (const id of targeted) {
      const tr = tracks.find((t) => t.id === id);
      if (tr && !tr.locked) affected.add(id);
    }
    if (options?.useSyncLock !== false) {
      const shouldSync = tracks.some((t) => affected.has(t.id) && t.syncLocked !== false);
      if (shouldSync) {
        for (const t of tracks) {
          if (!t.locked && t.syncLocked !== false) affected.add(t.id);
        }
      }
    }
    return affected;
  }

  const base = new Set(tracks.filter((t) => !t.locked).map((t) => t.id));
  if (options?.useSyncLock !== false) {
    const shouldSync = tracks.some((t) => base.has(t.id) && t.syncLocked !== false);
    if (shouldSync) {
      for (const t of tracks) {
        if (!t.locked && t.syncLocked !== false) base.add(t.id);
      }
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  mediaAssets: [],
  sequences: [],
  isLoading: false,
  error: null,
  _history: [],
  _future: [],

  // ---------------------------------------------------------------------------
  // Undo / Redo
  // ---------------------------------------------------------------------------

  _pushHistory: () => {
    const seq = get().sequences[0];
    if (!seq) return;
    const data = getSeqData(seq);
    const entry: HistoryEntry = {
      data: JSON.parse(JSON.stringify(data)),
      seqId: seq.id,
    };
    set((s) => ({
      _history: [...s._history.slice(-MAX_HISTORY), entry],
      _future: [], // Clear redo stack on new action
    }));
  },

  canUndo: () => get()._history.length > 0,
  canRedo: () => get()._future.length > 0,

  undo: async () => {
    const { _history, sequences } = get();
    if (_history.length === 0) return;
    const seq = sequences[0];
    if (!seq) return;

    const currentData = getSeqData(seq);
    const prev = _history[_history.length - 1];

    const futureEntry: HistoryEntry = {
      data: JSON.parse(JSON.stringify(currentData)),
      seqId: seq.id,
    };

    const restoredData = prev.data;

    set((s) => ({
      _history: s._history.slice(0, -1),
      _future: [...s._future, futureEntry],
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? { ...sq, data: restoredData as unknown as Record<string, unknown> } : sq,
      ),
    }));

    try {
      await enqueueSequenceUpdate(seq.id, {
        data: restoredData as unknown as Record<string, unknown>,
      });
    } catch (err) {
      console.warn('[projectStore] undo persist failed:', err);
    }
  },

  redo: async () => {
    const { _future, sequences } = get();
    if (_future.length === 0) return;
    const seq = sequences[0];
    if (!seq) return;

    const currentData = getSeqData(seq);
    const next = _future[_future.length - 1];

    const historyEntry: HistoryEntry = {
      data: JSON.parse(JSON.stringify(currentData)),
      seqId: seq.id,
    };

    const restoredData = next.data;

    set((s) => ({
      _future: s._future.slice(0, -1),
      _history: [...s._history, historyEntry],
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? { ...sq, data: restoredData as unknown as Record<string, unknown> } : sq,
      ),
    }));

    try {
      await enqueueSequenceUpdate(seq.id, {
        data: restoredData as unknown as Record<string, unknown>,
      });
    } catch (err) {
      console.warn('[projectStore] redo persist failed:', err);
    }
  },

  // ---------------------------------------------------------------------------
  // Project management (unchanged)
  // ---------------------------------------------------------------------------

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const projects = await api.projects.list();
      set({ projects, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  createProject: async (name: string, settings?: Record<string, unknown>) => {
    set({ isLoading: true, error: null });
    try {
      const project = await api.projects.create(name, settings);
      set((s) => ({ projects: [...s.projects, project], isLoading: false }));
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

      const migratedSequences: ApiSequence[] = [];
      for (const seq of project.sequences || []) {
        const current = getSeqData(seq);
        const ensured = ensureBaseTracks(current, seq.id);
        if (ensured.changed) {
          try {
            const updated = await enqueueSequenceUpdate(seq.id, {
              data: ensured.data as unknown as Record<string, unknown>,
            });
            migratedSequences.push(updated);
          } catch {
            migratedSequences.push({
              ...seq,
              data: ensured.data as unknown as Record<string, unknown>,
            });
          }
        } else {
          migratedSequences.push(seq);
        }
      }

      set({
        currentProject: project,
        mediaAssets,
        sequences: migratedSequences,
        isLoading: false,
        _history: [],
        _future: [],
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
      _history: [],
      _future: [],
    });
  },

  deleteProject: async (id: string) => {
    try {
      await api.projects.delete(id);
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        currentProject: s.currentProject?.id === id ? null : s.currentProject,
        mediaAssets: s.currentProject?.id === id ? [] : s.mediaAssets,
        sequences: s.currentProject?.id === id ? [] : s.sequences,
      }));
      const refreshed = await api.projects.list();
      set({ projects: refreshed });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  updateProjectSettings: async (settings) => {
    const project = get().currentProject;
    if (!project) return;

    set({ isLoading: true, error: null });

    try {
      const updatedProject = await api.projects.update(project.id, { settings });

      let updatedSequences = get().sequences;
      const firstSeq = updatedSequences[0];
      if (firstSeq && (settings.defaultFrameRate || settings.defaultResolution)) {
        const updatedSeq = await enqueueSequenceUpdate(firstSeq.id, {
          frameRate: settings.defaultFrameRate,
          resolution: settings.defaultResolution,
        });
        updatedSequences = updatedSequences.map((sq) => (sq.id === firstSeq.id ? updatedSeq : sq));
      }

      set((s) => ({
        currentProject: updatedProject,
        projects: s.projects.map((p) => (p.id === updatedProject.id ? updatedProject : p)),
        sequences: updatedSequences,
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
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

  uploadMedia: async (files: FileList | File[]) => {
    const project = get().currentProject;
    if (!project) return;
    if (!files || (files instanceof FileList && files.length === 0)) return;

    set({ isLoading: true, error: null });
    try {
      const result = await api.media.upload(project.id, files);
      set((s) => ({
        mediaAssets: [...s.mediaAssets, ...result.imported],
        isLoading: false,
      }));
      if (result.errors.length > 0) {
        const errorNames = result.errors.map((e) => e.name).join(', ');
        set({ error: `Failed to import: ${errorNames}` });
      }
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  deleteMedia: async (assetId: string) => {
    const project = get().currentProject;
    if (!project) return;

    try {
      const sequences = get().sequences;
      const updatedSequences: ApiSequence[] = [];

      for (const seq of sequences) {
        const data = getSeqData(seq);
        let changed = false;
        const updatedTracks = data.tracks.map((t) => {
          const nextClips = t.clips.filter((c) => c.mediaAssetId !== assetId);
          if (nextClips.length !== t.clips.length) changed = true;
          return changed ? { ...t, clips: nextClips } : t;
        });

        if (changed) {
          const updatedData = { ...data, tracks: updatedTracks };
          const updatedSeq = await enqueueSequenceUpdate(seq.id, {
            data: updatedData as Record<string, unknown>,
          });
          updatedSequences.push(updatedSeq);
        } else {
          updatedSequences.push(seq);
        }
      }

      await api.media.delete(project.id, assetId);
      set((s) => ({
        mediaAssets: s.mediaAssets.filter((a) => a.id !== assetId),
        sequences: updatedSequences,
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  // ---------------------------------------------------------------------------
  // Timeline editing
  // ---------------------------------------------------------------------------

  addTrack: async (type: 'video' | 'audio') => {
    const seq = get().sequences[0];
    if (!seq) return null;

    get()._pushHistory();

    const data = getSeqData(seq);
    const newTrack: TimelineTrackData = {
      id: generateId(),
      sequenceId: seq.id,
      name: nextTrackName(data.tracks, type),
      type,
      index: 0,
      locked: false,
      syncLocked: true,
      visible: true,
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      channelMode: 'stereo',
      channelMap: 'L+R',
      clips: [],
    };

    let tracks = [...data.tracks];
    if (type === 'video') {
      // Video tracks are ordered top-to-bottom by array order.
      // Insert new video tracks at the top (index 0).
      tracks.splice(0, 0, newTrack);
    } else {
      tracks.push(newTrack);
    }

    tracks = normalizeTrackIndices(tracks);
    const updatedData = { ...data, tracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
      return newTrack.id;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  addClipToTrack: async ({
    trackId,
    asset,
    startFrame,
    sourceInFrame,
    sourceOutFrame,
    insertMode,
    audioOnly,
  }) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);
    const effectiveType = audioOnly && asset.type === 'video' ? 'audio' : asset.type;
    const desiredTrackType = assetTypeToTrackType(effectiveType as ApiMediaAsset['type']);
    let track = data.tracks.find(
      (t) => t.id === trackId && t.type === desiredTrackType && !t.locked,
    );
    if (!track) {
      track = data.tracks.find((t) => t.type === desiredTrackType && !t.locked);
    }
    if (!track) return;

    const fps = seq.frameRate?.num ?? 24;
    const den = seq.frameRate?.den ?? 1;
    const fpsValue = fps / den;

    let clipInFrame = Math.max(0, sourceInFrame ?? 0);
    let clipOutFrame = sourceOutFrame ?? null;

    if (clipOutFrame == null) {
      let totalFrames = Math.round(fpsValue * 5);
      if (asset.duration != null && asset.duration > 0) {
        totalFrames = Math.round(asset.duration * fpsValue);
      }
      clipOutFrame = totalFrames;
    }

    if (clipOutFrame != null && clipOutFrame <= clipInFrame) {
      if (asset.duration != null && asset.duration > 0) {
        clipOutFrame = Math.round(asset.duration * fpsValue);
      } else {
        clipOutFrame = clipInFrame + Math.max(1, Math.round(fpsValue));
      }
    }

    const durationFrames = Math.max(1, (clipOutFrame ?? clipInFrame + 1) - clipInFrame);

    const newClipId = generateId();
    const newClip: TimelineClipData = {
      id: newClipId,
      name:
        effectiveType === 'audio' && asset.type === 'video' ? `${asset.name} (Audio)` : asset.name,
      type: effectiveType,
      startFrame,
      durationFrames,
      mediaAssetId: asset.id,
      sourceInFrame: clipInFrame,
      sourceOutFrame: clipInFrame + durationFrames,
      audioGainDb: 0,
      gain: 1,
      pan: 0,
      audioVolume: 1,
      audioPan: 0,
    };

    const updatedTracks = data.tracks.map((t) => {
      if (t.id !== track.id) return t;
      return {
        ...t,
        clips:
          insertMode === 'ripple'
            ? rippleInsertTrackWithClip(t.clips, newClip)
            : overwriteTrackWithClip(t.clips, newClip),
      };
    });

    if (asset.type === 'video' && !audioOnly) {
      const pairedAudioTrackId = findPairedAudioTrackId(updatedTracks, track.id);
      const audioTrack = pairedAudioTrackId
        ? updatedTracks.find((t) => t.id === pairedAudioTrackId)
        : null;
      if (audioTrack) {
        const audioClip: TimelineClipData = {
          ...newClip,
          id: generateId(),
          type: 'audio',
          name: `${asset.name} (Audio)`,
          linkedClipId: newClipId,
        };
        newClip.linkedClipId = audioClip.id;
        for (let i = 0; i < updatedTracks.length; i++) {
          if (updatedTracks[i].id === audioTrack.id) {
            updatedTracks[i] = {
              ...updatedTracks[i],
              clips:
                insertMode === 'ripple'
                  ? rippleInsertTrackWithClip(updatedTracks[i].clips, audioClip)
                  : overwriteTrackWithClip(updatedTracks[i].clips, audioClip),
            };
            break;
          }
        }
      }
    }
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  removeClips: async (clipIds: string[]) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);
    const clipIdSet = new Set(clipIds);

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => !clipIdSet.has(c.id)),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  moveClip: async (clipId, newTrackId, newStartFrame, options) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    let movedClip: TimelineClipData | null = null;
    let originalStartFrame = 0;
    const tracksWithout = data.tracks.map((t) => {
      const clip = t.clips.find((c) => c.id === clipId);
      if (clip) {
        originalStartFrame = clip.startFrame;
        movedClip = { ...clip, startFrame: Math.max(0, newStartFrame) };
        return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
      }
      return t;
    });

    if (!movedClip) return;

    const moved = movedClip as TimelineClipData;
    const desiredTrackType = clipTypeToTrackType(moved.type);
    let targetTrack = tracksWithout.find(
      (t) => t.id === newTrackId && t.type === desiredTrackType && !t.locked,
    );
    if (!targetTrack) {
      targetTrack = tracksWithout.find((t) => t.type === desiredTrackType && !t.locked);
    }
    if (!targetTrack) return;

    const updatedTracks = tracksWithout.map((t) => {
      if (t.id !== targetTrack.id) return t;
      return {
        ...t,
        clips: overwriteTrackWithClip(t.clips, moved, clipId),
      };
    });

    const delta = moved.startFrame - originalStartFrame;
    if (delta !== 0 && moved.linkedClipId && !options?.unlink) {
      for (let i = 0; i < updatedTracks.length; i++) {
        const tr = updatedTracks[i];
        if (tr.locked) continue;
        const linkedIndex = tr.clips.findIndex((c) => c.id === moved.linkedClipId);
        if (linkedIndex === -1) continue;
        const linked = tr.clips[linkedIndex];
        const nextStart = Math.max(0, linked.startFrame + delta);
        const updatedLinked = { ...linked, startFrame: nextStart };
        const others = tr.clips.filter((c) => c.id !== moved.linkedClipId);
        updatedTracks[i] = {
          ...tr,
          clips: overwriteTrackWithClip(others, updatedLinked, moved.linkedClipId),
        };
        break;
      }
    }
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  /**
   * Trim clip ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â adjusts startFrame, durationFrames, AND sourceIn/Out.
   *
   * Left trim (newStartFrame > old): sourceInFrame shifts forward.
   * Right trim (durationFrames changes): sourceOutFrame adjusts.
   */
  trimClip: async (clipId, newStartFrame, newDurationFrames, options) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    let targetClip: TimelineClipData | null = null;
    for (const track of data.tracks) {
      const c = track.clips.find((clip) => clip.id === clipId);
      if (c) {
        targetClip = c;
        break;
      }
    }
    if (!targetClip) return;

    const targetTrim = computeTrimResult(targetClip, newStartFrame, newDurationFrames);
    const deltaStart = targetTrim.startFrame - targetClip.startFrame;
    const deltaDuration = targetTrim.durationFrames - targetClip.durationFrames;
    const linkedId = !options?.unlink ? targetClip.linkedClipId : undefined;

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id === clipId) {
          return {
            ...c,
            startFrame: targetTrim.startFrame,
            durationFrames: targetTrim.durationFrames,
            sourceInFrame: targetTrim.sourceInFrame,
            sourceOutFrame: targetTrim.sourceOutFrame,
          };
        }

        if (linkedId && c.id === linkedId) {
          const linkedTrim = computeTrimResult(
            c,
            c.startFrame + deltaStart,
            c.durationFrames + deltaDuration,
          );
          return {
            ...c,
            startFrame: linkedTrim.startFrame,
            durationFrames: linkedTrim.durationFrames,
            sourceInFrame: linkedTrim.sourceInFrame,
            sourceOutFrame: linkedTrim.sourceOutFrame,
          };
        }

        return c;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  // ---------------------------------------------------------------------------
  // Milestone 2 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â new actions
  // ---------------------------------------------------------------------------

  /**
   * Split a clip at the playhead into two clips.
   * Correctly computes sourceInFrame/sourceOutFrame for both halves.
   */
  splitClipAtPlayhead: async (clipId: string, frame: number) => {
    const seq = get().sequences[0];
    if (!seq) return;

    const data = getSeqData(seq);

    // Find the clip and its track
    let foundClip: TimelineClipData | null = null;
    let foundTrackId: string | null = null;
    for (const track of data.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) {
        foundClip = clip;
        foundTrackId = track.id;
        break;
      }
    }
    if (!foundClip || !foundTrackId) return;

    // Validate: frame must be strictly inside the clip
    const clipEnd = foundClip.startFrame + foundClip.durationFrames;
    if (frame <= foundClip.startFrame || frame >= clipEnd) return;

    get()._pushHistory();

    const sourceIn = foundClip.sourceInFrame ?? 0;
    const localSplitFrame = frame - foundClip.startFrame;

    // Clip A: original start ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ split point
    const clipA: TimelineClipData = {
      ...foundClip,
      durationFrames: localSplitFrame,
      sourceOutFrame: sourceIn + localSplitFrame,
    };

    // Clip B: split point ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ original end
    const clipB: TimelineClipData = {
      ...foundClip,
      id: generateId(),
      name: foundClip.name + ' (2)',
      startFrame: frame,
      durationFrames: foundClip.durationFrames - localSplitFrame,
      sourceInFrame: sourceIn + localSplitFrame,
      sourceOutFrame: sourceIn + foundClip.durationFrames,
    };

    let linkedA: TimelineClipData | null = null;
    let linkedB: TimelineClipData | null = null;

    if (foundClip.linkedClipId) {
      let linkedClip: TimelineClipData | null = null;
      let linkedTrackId: string | null = null;
      for (const track of data.tracks) {
        const c = track.clips.find((x) => x.id === foundClip!.linkedClipId);
        if (c) {
          linkedClip = c;
          linkedTrackId = track.id;
          break;
        }
      }

      if (linkedClip && linkedTrackId) {
        const linkedLocalSplit = Math.min(
          Math.max(1, localSplitFrame),
          Math.max(1, linkedClip.durationFrames - 1),
        );
        const linkedFrame = linkedClip.startFrame + linkedLocalSplit;
        const lSourceIn = linkedClip.sourceInFrame ?? 0;

        linkedA = {
          ...linkedClip,
          durationFrames: linkedLocalSplit,
          sourceOutFrame: lSourceIn + linkedLocalSplit,
        };

        linkedB = {
          ...linkedClip,
          id: generateId(),
          name: linkedClip.name + ' (2)',
          startFrame: linkedFrame,
          durationFrames: linkedClip.durationFrames - linkedLocalSplit,
          sourceInFrame: lSourceIn + linkedLocalSplit,
          sourceOutFrame: lSourceIn + linkedClip.durationFrames,
        };

        // Keep pair links on the newly split clips
        clipA.linkedClipId = linkedA.id;
        clipB.linkedClipId = linkedB.id;
        linkedA.linkedClipId = clipA.id;
        linkedB.linkedClipId = clipB.id;
      }
    }

    const tId = foundTrackId;
    const updatedTracks = data.tracks.map((t) => {
      const hasPrimary = t.id === tId;
      const hasLinked = linkedA && linkedB ? t.clips.some((c) => c.id === linkedA!.id) : false;
      if (!hasPrimary && !hasLinked) return t;

      return {
        ...t,
        clips: t.clips.flatMap((c) => {
          if (hasPrimary && c.id === clipId) return [clipA, clipB];
          if (hasLinked && linkedA && linkedB && c.id === linkedA.id) return [linkedA, linkedB];
          return [c];
        }),
      };
    });
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  /**
   * Update arbitrary properties on a clip (transform, opacity, speed, etc.).
   */
  updateClipProperties: async (clipId: string, props: Partial<TimelineClipData>) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    let targetClip: TimelineClipData | null = null;
    for (const track of data.tracks) {
      const found = track.clips.find((c) => c.id === clipId);
      if (found) {
        targetClip = found;
        break;
      }
    }
    const linkedClipId = targetClip?.linkedClipId;

    const applySpeedChange = (
      c: TimelineClipData,
      requested: number,
      extra: Partial<TimelineClipData>,
    ): TimelineClipData => {
      const oldSpeedRaw = c.speed ?? 1;
      const oldSpeedAbs = Math.max(0.01, Math.abs(oldSpeedRaw));
      const sign = requested < 0 ? -1 : requested > 0 ? 1 : oldSpeedRaw < 0 ? -1 : 1;
      const nextSpeedAbs = Math.max(0.1, Math.abs(requested || oldSpeedRaw));
      const sourceIn = c.sourceInFrame ?? 0;
      const inferredOut = sourceIn + Math.max(1, Math.round(c.durationFrames * oldSpeedAbs));
      const sourceOut = c.sourceOutFrame ?? inferredOut;
      const sourceSpan = Math.max(1, sourceOut - sourceIn);
      const nextDuration = Math.max(1, Math.round(sourceSpan / nextSpeedAbs));

      return {
        ...c,
        ...extra,
        speed: sign * nextSpeedAbs,
        durationFrames: nextDuration,
        sourceInFrame: sourceIn,
        sourceOutFrame: sourceIn + sourceSpan,
      };
    };

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id === clipId) {
          if (props.speed === undefined) return { ...c, ...props };
          return applySpeedChange(c, Number(props.speed), props);
        }

        if (props.speed !== undefined && linkedClipId && c.id === linkedClipId) {
          return applySpeedChange(c, Number(props.speed), { speed: Number(props.speed) });
        }

        return c;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    // Optimistic local update to keep UI/audio responsive while dragging sliders.
    set((s) => ({
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? ({ ...sq, data: updatedData } as ApiSequence) : sq,
      ),
    }));

    const token = ++clipPropsMutationToken;

    try {
      await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      if (token !== clipPropsMutationToken) {
        // A newer slider update already replaced this state; ignore stale completion.
        return;
      }
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  /**
   * Ripple trim: trims a clip AND shifts all subsequent clips on the same
   * track to close or open the gap.
   */
  rippleTrimClip: async (
    clipId: string,
    newStartFrame: number,
    newDurationFrames: number,
    options,
  ) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    let targetClip: TimelineClipData | null = null;
    for (const track of data.tracks) {
      const c = track.clips.find((clip) => clip.id === clipId);
      if (c) {
        targetClip = c;
        break;
      }
    }
    if (!targetClip) return;

    const targetTrim = computeTrimResult(targetClip, newStartFrame, newDurationFrames);
    const deltaStart = targetTrim.startFrame - targetClip.startFrame;
    const deltaDuration = targetTrim.durationFrames - targetClip.durationFrames;
    const linkedId = !options?.unlink ? targetClip.linkedClipId : undefined;

    const updatedTracks = data.tracks.map((t) => {
      const target = t.clips.find((c) => c.id === clipId);
      const linked = linkedId ? t.clips.find((c) => c.id === linkedId) : undefined;
      if (!target && !linked) return t;

      const activeClip = target ?? linked!;
      const trim = target
        ? targetTrim
        : computeTrimResult(
            activeClip,
            activeClip.startFrame + deltaStart,
            activeClip.durationFrames + deltaDuration,
          );

      const rippleDelta = trim.newEnd - trim.oldEnd;

      return {
        ...t,
        clips: t.clips.map((c) => {
          if (c.id === activeClip.id) {
            return {
              ...c,
              startFrame: trim.startFrame,
              durationFrames: trim.durationFrames,
              sourceInFrame: trim.sourceInFrame,
              sourceOutFrame: trim.sourceOutFrame,
            };
          }
          if (c.startFrame >= trim.oldEnd) {
            return { ...c, startFrame: Math.max(0, c.startFrame + rippleDelta) };
          }
          return c;
        }),
      };
    });
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  /**
   * Ripple delete: removes clips AND shifts subsequent clips on each track
   * to fill the gap.
   */
  rippleDeleteClips: async (clipIds: string[]) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);
    const clipIdSet = new Set(clipIds);

    const updatedTracks = data.tracks.map((t) => {
      const deletedOnTrack = t.clips
        .filter((c) => clipIdSet.has(c.id))
        .sort((a, b) => a.startFrame - b.startFrame);

      if (deletedOnTrack.length === 0) {
        return { ...t, clips: t.clips.filter((c) => !clipIdSet.has(c.id)) };
      }

      const remaining = t.clips.filter((c) => !clipIdSet.has(c.id));
      const shifted = remaining.map((c) => {
        let totalShift = 0;
        for (const del of deletedOnTrack) {
          if (del.startFrame + del.durationFrames <= c.startFrame) {
            totalShift += del.durationFrames;
          }
        }
        return totalShift > 0 ? { ...c, startFrame: Math.max(0, c.startFrame - totalShift) } : c;
      });

      return { ...t, clips: shifted };
    });
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  liftRangeByInOut: async (inFrame: number, outFrame: number, options) => {
    const seq = get().sequences[0];
    if (!seq) return;

    const rangeIn = Math.max(0, Math.min(inFrame, outFrame));
    const rangeOut = Math.max(rangeIn + 1, Math.max(inFrame, outFrame));

    get()._pushHistory();

    const data = getSeqData(seq);
    const affectedTrackIds = resolveAffectedTrackIds(data.tracks, options);

    const updatedTracks = data.tracks.map((t) => {
      if (t.locked || !affectedTrackIds.has(t.id)) return t;
      const clips = t.clips.flatMap((clip) => cutClipByRange(clip, rangeIn, rangeOut, 'lift'));
      clips.sort((a, b) => a.startFrame - b.startFrame);
      return { ...t, clips };
    });

    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  extractRangeByInOut: async (inFrame: number, outFrame: number, options) => {
    const seq = get().sequences[0];
    if (!seq) return;

    const rangeIn = Math.max(0, Math.min(inFrame, outFrame));
    const rangeOut = Math.max(rangeIn + 1, Math.max(inFrame, outFrame));

    get()._pushHistory();

    const data = getSeqData(seq);
    const affectedTrackIds = resolveAffectedTrackIds(data.tracks, options);

    const updatedTracks = data.tracks.map((t) => {
      if (t.locked || !affectedTrackIds.has(t.id)) return t;
      const clips = t.clips.flatMap((clip) => cutClipByRange(clip, rangeIn, rangeOut, 'extract'));
      clips.sort((a, b) => a.startFrame - b.startFrame);
      return { ...t, clips };
    });

    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  // ---------------------------------------------------------------------------
  // Milestone 3 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â track management
  // ---------------------------------------------------------------------------

  updateTrack: async (trackId: string, props) => {
    const seq = get().sequences[0];
    if (!seq) return;

    get()._pushHistory();

    const data = getSeqData(seq);

    const updatedTracks = data.tracks.map((t) => (t.id === trackId ? { ...t, ...props } : t));
    const updatedData = { ...data, tracks: updatedTracks };

    // Optimistic update
    set((s) => ({
      sequences: s.sequences.map((sq) =>
        sq.id === seq.id ? { ...sq, data: updatedData as unknown as Record<string, unknown> } : sq,
      ),
    }));

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      console.warn('[projectStore] updateTrack persist failed:', err);
    }
  },

  isTrackLocked: (trackId: string) => {
    const seq = get().sequences[0];
    if (!seq) return false;
    const data = getSeqData(seq);
    const track = data.tracks.find((t) => t.id === trackId);
    return track?.locked ?? false;
  },

  unlinkSelectedClips: async (clipIds: string[]) => {
    const seq = get().sequences[0];
    if (!seq || clipIds.length === 0) return;

    get()._pushHistory();

    const idSet = new Set(clipIds);
    const data = getSeqData(seq);

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (idSet.has(c.id)) {
          return { ...c, linkedClipId: undefined };
        }
        if (c.linkedClipId && idSet.has(c.linkedClipId)) {
          return { ...c, linkedClipId: undefined };
        }
        return c;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  relinkSelectedClips: async (clipIds: string[]) => {
    const seq = get().sequences[0];
    if (!seq || clipIds.length < 2) return;

    get()._pushHistory();
    const data = getSeqData(seq);

    type ClipWithTrack = { clip: TimelineClipData; trackType: 'video' | 'audio' };
    const selected: ClipWithTrack[] = [];
    const idSet = new Set(clipIds);
    for (const t of data.tracks) {
      for (const c of t.clips) {
        if (idSet.has(c.id)) {
          const trackType: 'video' | 'audio' = c.type === 'audio' ? 'audio' : 'video';
          selected.push({ clip: c, trackType });
        }
      }
    }

    if (selected.length < 2) return;

    const linkMap = new Map<string, string | undefined>();
    for (const { clip } of selected) {
      linkMap.set(clip.id, undefined);
    }

    const videos = selected.filter((x) => x.trackType === 'video').map((x) => x.clip);
    const audios = selected.filter((x) => x.trackType === 'audio').map((x) => x.clip);

    const usedAudio = new Set<string>();

    const scorePair = (v: TimelineClipData, a: TimelineClipData): number => {
      const vS = v.startFrame;
      const vE = v.startFrame + v.durationFrames;
      const aS = a.startFrame;
      const aE = a.startFrame + a.durationFrames;
      const overlap = Math.max(0, Math.min(vE, aE) - Math.max(vS, aS));
      const centerDist = Math.abs((vS + vE) / 2 - (aS + aE) / 2);
      return overlap * 1000 - centerDist;
    };

    for (const v of videos) {
      let best: TimelineClipData | null = null;
      let bestScore = -Infinity;
      for (const a of audios) {
        if (usedAudio.has(a.id)) continue;
        const s = scorePair(v, a);
        if (s > bestScore) {
          bestScore = s;
          best = a;
        }
      }
      if (best) {
        usedAudio.add(best.id);
        linkMap.set(v.id, best.id);
        linkMap.set(best.id, v.id);
      }
    }

    const updatedTracks = data.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (idSet.has(c.id)) {
          return { ...c, linkedClipId: linkMap.get(c.id) };
        }
        // Remove stale links that point into relinked set
        if (c.linkedClipId && idSet.has(c.linkedClipId)) {
          return { ...c, linkedClipId: undefined };
        }
        return c;
      }),
    }));
    const updatedData = { ...data, tracks: updatedTracks };

    try {
      const updatedSeq = await enqueueSequenceUpdate(seq.id, {
        data: updatedData as Record<string, unknown>,
      });
      set((s) => ({
        sequences: s.sequences.map((sq) => (sq.id === seq.id ? updatedSeq : sq)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setError: (error: string | null) => set({ error }),
}));
