/**
 * Playback state store — manages current playhead position,
 * play/pause state, and shuttle speed.
 */

import { create } from 'zustand';

export interface TimelineMarker {
  id: string;
  frame: number;
  name: string;
  color: string;
}

interface PlaybackState {
  isPlaying: boolean;
  currentFrame: number;
  totalFrames: number;
  fps: number;
  shuttleSpeed: number; // -4, -2, -1, 0, 1, 2, 4 (negative = reverse)
  inPoint: number | null; // frame number
  outPoint: number | null; // frame number
  loopPlayback: boolean;
  timelineZoom: number;
  markers: TimelineMarker[];
  audioMeterLeft: number;
  audioMeterRight: number;

  // Actions
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  setCurrentFrame: (frame: number) => void;
  stepForward: () => void;
  stepBackward: () => void;
  goToStart: () => void;
  goToEnd: () => void;
  setInPoint: () => void;
  setOutPoint: () => void;
  setInPointAt: (frame: number) => void;
  setOutPointAt: (frame: number) => void;
  clearInOutPoints: () => void;
  setTotalFrames: (frames: number) => void;
  setFps: (fps: number) => void;
  shuttleForward: () => void;
  shuttleReverse: () => void;
  shuttlePause: () => void;
  setLoopPlayback: (loop: boolean) => void;
  setTimelineZoom: (zoom: number) => void;
  zoomInTimeline: () => void;
  zoomOutTimeline: () => void;
  toggleMarkerAtCurrent: () => void;
  jumpToPrevMarker: () => void;
  jumpToNextMarker: () => void;
  removeMarker: (id: string) => void;
  updateMarker: (
    id: string,
    patch: Partial<Pick<TimelineMarker, 'name' | 'color' | 'frame'>>,
  ) => void;
  setAudioMeters: (left: number, right: number) => void;
}

const SHUTTLE_SPEEDS = [-4, -2, -1, 0, 1, 2, 4];
const MIN_TIMELINE_ZOOM = 0.005;
const MAX_TIMELINE_ZOOM = 32;

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  isPlaying: false,
  currentFrame: 0,
  totalFrames: 0,
  fps: 24,
  shuttleSpeed: 0,
  inPoint: null,
  outPoint: null,
  loopPlayback: false,
  timelineZoom: 1,
  markers: [],
  audioMeterLeft: 0,
  audioMeterRight: 0,

  play: () =>
    set((state) => {
      const start = state.inPoint ?? 0;
      const rawEnd = state.outPoint ?? state.totalFrames;
      const end = rawEnd > start ? rawEnd : state.totalFrames;
      if (end <= start) {
        return { isPlaying: false, shuttleSpeed: 0, currentFrame: start };
      }
      const currentFrame =
        state.currentFrame < start || state.currentFrame >= end ? start : state.currentFrame;
      return { isPlaying: true, shuttleSpeed: 1, currentFrame };
    }),
  pause: () => set({ isPlaying: false, shuttleSpeed: 0 }),

  togglePlayPause: () => {
    const { isPlaying } = get();
    if (isPlaying) {
      set({ isPlaying: false, shuttleSpeed: 0 });
    } else {
      set((state) => {
        const start = state.inPoint ?? 0;
        const rawEnd = state.outPoint ?? state.totalFrames;
        const end = rawEnd > start ? rawEnd : state.totalFrames;
        if (end <= start) {
          return { isPlaying: false, shuttleSpeed: 0, currentFrame: start };
        }
        const currentFrame =
          state.currentFrame < start || state.currentFrame >= end ? start : state.currentFrame;
        return { isPlaying: true, shuttleSpeed: 1, currentFrame };
      });
    }
  },

  setCurrentFrame: (frame) => {
    const { totalFrames } = get();
    set({ currentFrame: Math.max(0, Math.min(frame, totalFrames)) });
  },

  stepForward: () => {
    const { currentFrame, totalFrames } = get();
    set({
      currentFrame: Math.min(currentFrame + 1, totalFrames),
      isPlaying: false,
      shuttleSpeed: 0,
    });
  },

  stepBackward: () => {
    const { currentFrame } = get();
    set({ currentFrame: Math.max(currentFrame - 1, 0), isPlaying: false, shuttleSpeed: 0 });
  },

  goToStart: () => {
    const { inPoint } = get();
    set({ currentFrame: inPoint ?? 0, isPlaying: false, shuttleSpeed: 0 });
  },

  goToEnd: () => {
    const { outPoint, totalFrames } = get();
    set({ currentFrame: outPoint ?? totalFrames, isPlaying: false, shuttleSpeed: 0 });
  },

  setInPoint: () => {
    const { currentFrame } = get();
    set({ inPoint: currentFrame });
  },

  setOutPoint: () => {
    const { currentFrame } = get();
    set({ outPoint: currentFrame });
  },

  setInPointAt: (frame) => {
    const { totalFrames, outPoint } = get();
    const clamped = Math.max(0, Math.min(frame, totalFrames));
    if (outPoint != null) {
      set({ inPoint: Math.min(clamped, Math.max(0, outPoint - 1)) });
    } else {
      set({ inPoint: clamped });
    }
  },

  setOutPointAt: (frame) => {
    const { totalFrames, inPoint } = get();
    const clamped = Math.max(0, Math.min(frame, totalFrames));
    if (inPoint != null) {
      set({ outPoint: Math.max(clamped, inPoint + 1) });
    } else {
      set({ outPoint: clamped });
    }
  },

  clearInOutPoints: () => set({ inPoint: null, outPoint: null }),

  setTotalFrames: (frames) =>
    set((state) => {
      const totalFrames = Math.max(0, Math.round(frames));
      const currentFrame = Math.max(0, Math.min(state.currentFrame, totalFrames));
      const inPoint =
        state.inPoint == null
          ? null
          : Math.max(0, Math.min(state.inPoint, Math.max(0, totalFrames - 1)));
      let outPoint =
        state.outPoint == null ? null : Math.max(0, Math.min(state.outPoint, totalFrames));
      if (outPoint != null) {
        const start = inPoint ?? 0;
        if (outPoint <= start) outPoint = null;
      }
      return {
        totalFrames,
        currentFrame,
        inPoint,
        outPoint,
      };
    }),
  setFps: (fps) => set({ fps }),

  shuttleForward: () => {
    const { shuttleSpeed } = get();
    const idx = SHUTTLE_SPEEDS.indexOf(shuttleSpeed);
    const nextIdx = Math.min(idx + 1, SHUTTLE_SPEEDS.length - 1);
    const newSpeed = SHUTTLE_SPEEDS[nextIdx];
    set({ shuttleSpeed: newSpeed, isPlaying: newSpeed !== 0 });
  },

  shuttleReverse: () => {
    const { shuttleSpeed } = get();
    const idx = SHUTTLE_SPEEDS.indexOf(shuttleSpeed);
    const nextIdx = Math.max(idx - 1, 0);
    const newSpeed = SHUTTLE_SPEEDS[nextIdx];
    set({ shuttleSpeed: newSpeed, isPlaying: newSpeed !== 0 });
  },

  shuttlePause: () => set({ isPlaying: false, shuttleSpeed: 0 }),

  setLoopPlayback: (loop) => set({ loopPlayback: loop }),

  setTimelineZoom: (zoom) =>
    set({ timelineZoom: Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, zoom)) }),
  zoomInTimeline: () => {
    const z = get().timelineZoom;
    set({ timelineZoom: Math.min(MAX_TIMELINE_ZOOM, z * 1.25) });
  },
  zoomOutTimeline: () => {
    const z = get().timelineZoom;
    set({ timelineZoom: Math.max(MIN_TIMELINE_ZOOM, z / 1.25) });
  },

  toggleMarkerAtCurrent: () => {
    const { currentFrame, markers } = get();
    const existing = markers.find((m) => m.frame === currentFrame);
    if (existing) {
      set({ markers: markers.filter((m) => m.id !== existing.id) });
      return;
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    set({
      markers: [
        ...markers,
        { id, frame: currentFrame, name: `M${markers.length + 1}`, color: '#e879f9' },
      ].sort((a, b) => a.frame - b.frame),
    });
  },

  jumpToPrevMarker: () => {
    const { currentFrame, markers } = get();
    if (!markers.length) return;
    let prev = markers[0].frame;
    for (const m of markers) {
      if (m.frame < currentFrame) prev = m.frame;
      else break;
    }
    set({ currentFrame: prev, isPlaying: false, shuttleSpeed: 0 });
  },

  jumpToNextMarker: () => {
    const { currentFrame, markers, totalFrames } = get();
    if (!markers.length) return;
    for (const m of markers) {
      if (m.frame > currentFrame) {
        set({ currentFrame: m.frame, isPlaying: false, shuttleSpeed: 0 });
        return;
      }
    }
    set({
      currentFrame: Math.min(totalFrames, markers[markers.length - 1].frame),
      isPlaying: false,
      shuttleSpeed: 0,
    });
  },

  removeMarker: (id) => {
    const { markers } = get();
    set({ markers: markers.filter((m) => m.id !== id) });
  },

  updateMarker: (id, patch) => {
    const { markers, totalFrames } = get();
    set({
      markers: markers
        .map((m) => {
          if (m.id !== id) return m;
          const frame =
            patch.frame != null
              ? Math.max(0, Math.min(totalFrames, Math.round(patch.frame)))
              : m.frame;
          return { ...m, ...patch, frame };
        })
        .sort((a, b) => a.frame - b.frame),
    });
  },

  setAudioMeters: (left, right) =>
    set((state) => {
      const clamp = (v: number) => Math.max(0, Math.min(1, v));
      const nextL = clamp(left);
      const nextR = clamp(right);

      const attack = 0.75;
      const release = 0.18;
      const smooth = (prev: number, next: number) =>
        next >= prev ? prev + (next - prev) * attack : prev + (next - prev) * release;

      return {
        audioMeterLeft: smooth(state.audioMeterLeft, nextL),
        audioMeterRight: smooth(state.audioMeterRight, nextR),
      };
    }),
}));
