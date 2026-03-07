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
 *   Ctrl+Shift+Z / Ctrl+Y — Redo
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
  onJumpToPrevCut?: () => void;
  onJumpToNextCut?: () => void;
  onGoToStart?: () => void;
  onGoToEnd?: () => void;
  onSetInPoint?: () => void;
  onSetOutPoint?: () => void;
  onRazor?: () => void;
  onDelete?: (options?: { unlink?: boolean }) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onShuttleReverse?: () => void;
  onShuttlePause?: () => void;
  onShuttleForward?: () => void;
  onSelectTool?: () => void;
  onTrimDeleteBefore?: () => void;
  onTrimDeleteAfter?: () => void;
  onToggleMarker?: () => void;
  onPrevMarker?: () => void;
  onNextMarker?: () => void;
  onImportMedia?: () => void;
  onFocusMedia?: () => void;
  onFocusSource?: () => void;
  onFocusTimeline?: () => void;
  onFocusProgram?: () => void;
  onFocusInspector?: () => void;
  onInsertAction?: () => void;
  onOverwriteAction?: () => void;
  onSourceZoomIn?: () => void;
  onSourceZoomOut?: () => void;
  onStepForward10?: () => void;
  onStepBackward10?: () => void;
  onAltArrowLeft?: () => void;
  onAltArrowRight?: () => void;
  onAltArrowUp?: () => void;
  onAltArrowDown?: () => void;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
  onPasteInPlace?: () => void;
  onDuplicate?: () => void;
  onFitTimeline?: () => void;
  onZoomToFrame?: () => void;
  onCutAtPlayhead?: () => void;
  onToggleRippleMode?: () => void;
}

export function useKeyboard(actions: KeyboardActions) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const { key } = e;
      const mediaTransportKey =
        key === ' ' ||
        key === 'j' ||
        key === 'J' ||
        key === 'k' ||
        key === 'K' ||
        key === 'l' ||
        key === 'L';

      // Don't handle most shortcuts when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      ) {
        if (!mediaTransportKey) return;
      }

      const { ctrlKey, metaKey, altKey } = e;
      const mod = ctrlKey || metaKey;

      if (mod && key === 'i') {
        e.preventDefault();
        actions.onImportMedia?.();
        return;
      }

      if (mod && key === '1') {
        e.preventDefault();
        actions.onFocusMedia?.();
        return;
      }
      if (mod && key === '2') {
        e.preventDefault();
        actions.onFocusSource?.();
        return;
      }
      if (mod && key === '3') {
        e.preventDefault();
        actions.onFocusTimeline?.();
        return;
      }
      if (mod && key === '4') {
        e.preventDefault();
        actions.onFocusProgram?.();
        return;
      }
      if (mod && key === '5') {
        e.preventDefault();
        actions.onFocusInspector?.();
        return;
      }

      if (mod && (key === 'c' || key === 'C')) {
        e.preventDefault();
        actions.onCopy?.();
        return;
      }
      if (mod && (key === 'x' || key === 'X')) {
        e.preventDefault();
        actions.onCut?.();
        return;
      }
      if (mod && (key === 'v' || key === 'V')) {
        e.preventDefault();
        if (e.shiftKey) {
          actions.onPasteInPlace?.();
        } else {
          actions.onPaste?.();
        }
        return;
      }
      if (mod && (key === 'd' || key === 'D')) {
        e.preventDefault();
        actions.onDuplicate?.();
        return;
      }

      if (mod && (key === 'k' || key === 'K')) {
        e.preventDefault();
        actions.onCutAtPlayhead?.();
        return;
      }

      if (mod && (key === '=' || key === '+')) {
        e.preventDefault();
        actions.onSourceZoomIn?.();
        return;
      }
      if (mod && key === '-') {
        e.preventDefault();
        actions.onSourceZoomOut?.();
        return;
      }

      if (key === ',') {
        e.preventDefault();
        actions.onInsertAction?.();
        return;
      }
      if (key === '.') {
        e.preventDefault();
        actions.onOverwriteAction?.();
        return;
      }

      if (key === '\\') {
        e.preventDefault();
        actions.onFitTimeline?.();
        return;
      }

      if (key === '|') {
        e.preventDefault();
        actions.onZoomToFrame?.();
        return;
      }

      if (key === '`') {
        e.preventDefault();
        actions.onToggleRippleMode?.();
        return;
      }

      switch (key) {
        case ' ':
          e.preventDefault();
          actions.onPlayPause?.();
          break;

        case 'ArrowLeft':
          if (altKey) {
            e.preventDefault();
            actions.onAltArrowLeft?.();
            break;
          }
          if (e.shiftKey) {
            e.preventDefault();
            actions.onStepBackward10?.();
            break;
          }
          e.preventDefault();
          actions.onStepBackward?.();
          break;

        case 'ArrowRight':
          if (altKey) {
            e.preventDefault();
            actions.onAltArrowRight?.();
            break;
          }
          if (e.shiftKey) {
            e.preventDefault();
            actions.onStepForward10?.();
            break;
          }
          e.preventDefault();
          actions.onStepForward?.();
          break;

        case 'ArrowUp':
          if (altKey) {
            e.preventDefault();
            actions.onAltArrowUp?.();
            break;
          }
          e.preventDefault();
          actions.onJumpToPrevCut?.();
          break;

        case 'ArrowDown':
          if (altKey) {
            e.preventDefault();
            actions.onAltArrowDown?.();
            break;
          }
          e.preventDefault();
          actions.onJumpToNextCut?.();
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
          actions.onDelete?.({ unlink: altKey });
          break;

        case 'z':
        case 'Z':
          if (mod && e.shiftKey) {
            e.preventDefault();
            actions.onRedo?.();
          } else if (mod) {
            e.preventDefault();
            actions.onUndo?.();
          } else {
            e.preventDefault();
            if (e.shiftKey) {
              actions.onZoomOut?.();
            } else {
              actions.onZoomIn?.();
            }
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

        case 'v':
        case 'V':
          if (!mod) {
            e.preventDefault();
            actions.onSelectTool?.();
          }
          break;

        case 'q':
        case 'Q':
          if (!mod) {
            e.preventDefault();
            actions.onTrimDeleteBefore?.();
          }
          break;

        case 'w':
        case 'W':
          if (!mod) {
            e.preventDefault();
            actions.onTrimDeleteAfter?.();
          }
          break;

        case 'm':
        case 'M':
          if (!mod) {
            e.preventDefault();
            actions.onToggleMarker?.();
          }
          break;

        case '[':
          if (!mod) {
            e.preventDefault();
            actions.onPrevMarker?.();
          }
          break;

        case ']':
          if (!mod) {
            e.preventDefault();
            actions.onNextMarker?.();
          }
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
