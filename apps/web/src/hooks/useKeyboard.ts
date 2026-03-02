/**
 * Keyboard shortcuts hook for NLE editing operations.
 *
 * Standard shortcuts:
 *   Space      — Play / Pause toggle
 *   J / K / L  — Reverse / Pause / Forward (shuttle)
 *   I          — Set In point
 *   O          — Set Out point
 *   C          — Razor (split clip at playhead)
 *   Delete     — Delete selected clips
 *   Ctrl+Z     — Undo
 *   Ctrl+Y     — Redo
 *   Home       — Go to start
 *   End        — Go to end
 *   Left/Right — Step frame back/forward
 *   +/-        — Zoom in/out timeline
 */

import { useEffect, useCallback } from 'react';

export interface KeyboardActions {
  onPlayPause?: () => void;
  onStepForward?: () => void;
  onStepBackward?: () => void;
  onGoToStart?: () => void;
  onGoToEnd?: () => void;
  onSetInPoint?: () => void;
  onSetOutPoint?: () => void;
  onRazor?: () => void;
  onDelete?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onShuttleReverse?: () => void;
  onShuttlePause?: () => void;
  onShuttleForward?: () => void;
}

export function useKeyboard(actions: KeyboardActions) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        return;
      }

      const { key, ctrlKey, metaKey } = e;
      const mod = ctrlKey || metaKey;

      switch (key) {
        case ' ':
          e.preventDefault();
          actions.onPlayPause?.();
          break;

        case 'ArrowLeft':
          e.preventDefault();
          actions.onStepBackward?.();
          break;

        case 'ArrowRight':
          e.preventDefault();
          actions.onStepForward?.();
          break;

        case 'Home':
          e.preventDefault();
          actions.onGoToStart?.();
          break;

        case 'End':
          e.preventDefault();
          actions.onGoToEnd?.();
          break;

        case 'i':
        case 'I':
          if (!mod) {
            e.preventDefault();
            actions.onSetInPoint?.();
          }
          break;

        case 'o':
        case 'O':
          if (!mod) {
            e.preventDefault();
            actions.onSetOutPoint?.();
          }
          break;

        case 'c':
        case 'C':
          if (!mod) {
            e.preventDefault();
            actions.onRazor?.();
          }
          break;

        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          actions.onDelete?.();
          break;

        case 'z':
        case 'Z':
          if (mod) {
            e.preventDefault();
            actions.onUndo?.();
          }
          break;

        case 'y':
        case 'Y':
          if (mod) {
            e.preventDefault();
            actions.onRedo?.();
          }
          break;

        case '=':
        case '+':
          e.preventDefault();
          actions.onZoomIn?.();
          break;

        case '-':
          e.preventDefault();
          actions.onZoomOut?.();
          break;

        // J/K/L shuttle
        case 'j':
        case 'J':
          e.preventDefault();
          actions.onShuttleReverse?.();
          break;

        case 'k':
        case 'K':
          e.preventDefault();
          actions.onShuttlePause?.();
          break;

        case 'l':
        case 'L':
          e.preventDefault();
          actions.onShuttleForward?.();
          break;
      }
    },
    [actions],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
