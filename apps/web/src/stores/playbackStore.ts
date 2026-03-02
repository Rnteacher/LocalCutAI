/**
 * Playback state store — manages current playhead position,
 * play/pause state, and shuttle speed.
 */

import { create } from 'zustand';

interface PlaybackState {
  isPlaying: boolean;
  currentFrame: number;
  totalFrames: number;
  fps: number;
  shuttleSpeed: number; // -4, -2, -1, 0, 1, 2, 4 (negative = reverse)
  inPoint: number | null; // frame number
  outPoint: number | null; // frame number
  loopPlayback: boolean;

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
  clearInOutPoints: () => void;
  setTotalFrames: (frames: number) => void;
  setFps: (fps: number) => void;
  shuttleForward: () => void;
  shuttleReverse: () => void;
  shuttlePause: () => void;
  setLoopPlayback: (loop: boolean) => void;
}

const SHUTTLE_SPEEDS = [-4, -2, -1, 0, 1, 2, 4];

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  isPlaying: false,
  currentFrame: 0,
  totalFrames: 0,
  fps: 24,
  shuttleSpeed: 0,
  inPoint: null,
  outPoint: null,
  loopPlayback: false,

  play: () => set({ isPlaying: true, shuttleSpeed: 1 }),
  pause: () => set({ isPlaying: false, shuttleSpeed: 0 }),

  togglePlayPause: () => {
    const { isPlaying } = get();
    if (isPlaying) {
      set({ isPlaying: false, shuttleSpeed: 0 });
    } else {
      set({ isPlaying: true, shuttleSpeed: 1 });
    }
  },

  setCurrentFrame: (frame) => {
    const { totalFrames } = get();
    set({ currentFrame: Math.max(0, Math.min(frame, totalFrames)) });
  },

  stepForward: () => {
    const { currentFrame, totalFrames } = get();
    set({ currentFrame: Math.min(currentFrame + 1, totalFrames), isPlaying: false, shuttleSpeed: 0 });
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

  clearInOutPoints: () => set({ inPoint: null, outPoint: null }),

  setTotalFrames: (frames) => set({ totalFrames: frames }),
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
}));
