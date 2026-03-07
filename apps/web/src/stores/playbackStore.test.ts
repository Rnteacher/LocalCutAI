import { beforeEach, describe, expect, it } from 'vitest';
import { usePlaybackStore } from './playbackStore.js';

function resetPlaybackState(
  overrides: Partial<{
    isPlaying: boolean;
    currentFrame: number;
    totalFrames: number;
    fps: number;
    shuttleSpeed: number;
    inPoint: number | null;
    outPoint: number | null;
    loopPlayback: boolean;
    timelineZoom: number;
    markers: Array<{ id: string; frame: number; name: string; color: string }>;
    audioMeterLeft: number;
    audioMeterRight: number;
  }> = {},
): void {
  usePlaybackStore.setState({
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
    ...overrides,
  });
}

describe('playbackStore play range normalization', () => {
  beforeEach(() => {
    resetPlaybackState();
  });

  it('starts from inPoint when current frame is before playback range', () => {
    resetPlaybackState({ totalFrames: 120, inPoint: 12, outPoint: 100, currentFrame: 0 });

    usePlaybackStore.getState().play();

    const state = usePlaybackStore.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.shuttleSpeed).toBe(1);
    expect(state.currentFrame).toBe(12);
  });

  it('togglePlayPause also normalizes start frame into active range', () => {
    resetPlaybackState({ totalFrames: 120, inPoint: 24, outPoint: 90, currentFrame: 0 });

    usePlaybackStore.getState().togglePlayPause();

    const state = usePlaybackStore.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.shuttleSpeed).toBe(1);
    expect(state.currentFrame).toBe(24);
  });

  it('keeps current frame when already inside playback range', () => {
    resetPlaybackState({ totalFrames: 120, inPoint: 10, outPoint: 80, currentFrame: 35 });

    usePlaybackStore.getState().play();

    expect(usePlaybackStore.getState().currentFrame).toBe(35);
  });

  it('does not enter playing state for an empty playback range', () => {
    resetPlaybackState({ totalFrames: 0, inPoint: 0, outPoint: null, currentFrame: 0 });

    usePlaybackStore.getState().play();

    const state = usePlaybackStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.shuttleSpeed).toBe(0);
    expect(state.currentFrame).toBe(0);
  });
});