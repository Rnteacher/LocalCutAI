import { useMemo } from 'react';
import { Header } from '../components/Header.js';
import { ProjectBrowser } from '../components/ProjectBrowser.js';
import { Monitor } from '../components/Monitor.js';
import { Timeline } from '../components/Timeline.js';
import { Inspector } from '../components/Inspector.js';
import { StatusBar } from '../components/StatusBar.js';
import { useKeyboard } from '../hooks/useKeyboard.js';
import type { KeyboardActions } from '../hooks/useKeyboard.js';
import { usePlaybackStore } from '../stores/playbackStore.js';

export function App() {
  const togglePlayPause = usePlaybackStore((s) => s.togglePlayPause);
  const stepForward = usePlaybackStore((s) => s.stepForward);
  const stepBackward = usePlaybackStore((s) => s.stepBackward);
  const goToStart = usePlaybackStore((s) => s.goToStart);
  const goToEnd = usePlaybackStore((s) => s.goToEnd);
  const setInPoint = usePlaybackStore((s) => s.setInPoint);
  const setOutPoint = usePlaybackStore((s) => s.setOutPoint);
  const shuttleForward = usePlaybackStore((s) => s.shuttleForward);
  const shuttleReverse = usePlaybackStore((s) => s.shuttleReverse);
  const shuttlePause = usePlaybackStore((s) => s.shuttlePause);

  const keyActions: KeyboardActions = useMemo(
    () => ({
      onPlayPause: togglePlayPause,
      onStepForward: stepForward,
      onStepBackward: stepBackward,
      onGoToStart: goToStart,
      onGoToEnd: goToEnd,
      onSetInPoint: setInPoint,
      onSetOutPoint: setOutPoint,
      onShuttleForward: shuttleForward,
      onShuttleReverse: shuttleReverse,
      onShuttlePause: shuttlePause,
      onZoomIn: () => {}, // Timeline handles its own zoom
      onZoomOut: () => {},
    }),
    [
      togglePlayPause, stepForward, stepBackward, goToStart, goToEnd,
      setInPoint, setOutPoint, shuttleForward, shuttleReverse, shuttlePause,
    ],
  );

  useKeyboard(keyActions);

  return (
    <div className="flex h-screen w-screen flex-col bg-zinc-900 text-zinc-100">
      <Header />

      <main className="flex flex-1 overflow-hidden">
        <ProjectBrowser />

        <div className="flex flex-1 flex-col">
          {/* Monitors */}
          <div className="flex flex-1 border-b border-zinc-700">
            <div className="flex flex-1 border-r border-zinc-700">
              <Monitor type="source" />
            </div>
            <Monitor type="program" />
          </div>

          {/* Timeline */}
          <Timeline />
        </div>

        <Inspector />
      </main>

      <StatusBar />
    </div>
  );
}
