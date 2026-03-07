/**
 * usePlaybackLoop — requestAnimationFrame loop that advances the playhead.
 *
 * When `isPlaying` is true, this hook starts a rAF loop that increments
 * `currentFrame` in the playback store based on elapsed wall-clock time,
 * the configured fps, and the shuttle speed.
 *
 * Mount this once at the App root level.
 */

import { useEffect, useRef } from 'react';
import { usePlaybackStore } from '../stores/playbackStore.js';

export function usePlaybackLoop(): void {
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  /** Sub-frame accumulator for smooth playback at any fps. */
  const accumRef = useRef(0);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      return;
    }

    // Initialise on play start
    lastTsRef.current = performance.now();
    accumRef.current = usePlaybackStore.getState().currentFrame;

    const tick = (now: number) => {
      const state = usePlaybackStore.getState();
      if (!state.isPlaying) return;

      const elapsedSec = (now - lastTsRef.current) / 1000;
      lastTsRef.current = now;

      // Advance the accumulator by elapsed * fps * speed
      accumRef.current += elapsedSec * state.fps * state.shuttleSpeed;

      const startFrame = state.inPoint ?? 0;
      const rawEndFrame = state.outPoint ?? state.totalFrames;
      const endFrame = rawEndFrame > startFrame ? rawEndFrame : state.totalFrames;
      if (endFrame <= startFrame) {
        state.pause();
        return;
      }
      let frame =
        state.shuttleSpeed >= 0
          ? Math.floor(accumRef.current + 1e-6)
          : Math.ceil(accumRef.current - 1e-6);

      // If playhead starts outside the active range, clamp into range first.
      if (state.shuttleSpeed >= 0 && frame < startFrame) {
        frame = startFrame;
        accumRef.current = startFrame;
      } else if (state.shuttleSpeed < 0 && frame >= endFrame) {
        frame = endFrame - 1;
        accumRef.current = endFrame - 1;
      }

      // Forward boundary
      if (frame >= endFrame) {
        if (state.loopPlayback && endFrame > startFrame) {
          frame = startFrame;
          accumRef.current = startFrame;
        } else {
          state.setCurrentFrame(endFrame);
          state.pause();
          return;
        }
      }

      // Reverse boundary
      if (frame < startFrame) {
        if (state.loopPlayback && endFrame > startFrame) {
          frame = endFrame - 1;
          accumRef.current = endFrame - 1;
        } else {
          state.setCurrentFrame(startFrame);
          state.pause();
          return;
        }
      }

      state.setCurrentFrame(frame);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [isPlaying]);
}
