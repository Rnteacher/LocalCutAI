import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { Header } from '../components/Header.js';
import { ProjectBrowser } from '../components/ProjectBrowser.js';
import { ProjectsScreen } from '../components/ProjectsScreen.js';
import { SourceMonitor } from '../components/Monitor.js';
import { ProgramMonitor } from '../components/ProgramMonitor.js';
import { Timeline } from '../components/Timeline.js';
import { Inspector } from '../components/Inspector.js';
import { StatusBar } from '../components/StatusBar.js';
import { useKeyboard } from '../hooks/useKeyboard.js';
import type { KeyboardActions } from '../hooks/useKeyboard.js';
import { usePlaybackLoop } from '../hooks/usePlaybackLoop.js';
import { useAudioEngine } from '../hooks/useAudioEngine.js';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import type { TimelineTrackData } from '../stores/projectStore.js';

function dispatchSourceCommand(command: string): void {
  window.dispatchEvent(new CustomEvent('localcut:source-command', { detail: { command } }));
}

function dispatchMediaImportOpen(): void {
  window.dispatchEvent(new CustomEvent('localcut:open-media-import'));
}

function dispatchTimelineCommand(command: string): void {
  window.dispatchEvent(new CustomEvent('localcut:timeline-command', { detail: { command } }));
}

export function App() {
  // Mount the rAF playback loop once at root
  usePlaybackLoop();
  // Mount the audio engine (Web Audio API) once at root
  useAudioEngine();

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
  const zoomInTimeline = usePlaybackStore((s) => s.zoomInTimeline);
  const zoomOutTimeline = usePlaybackStore((s) => s.zoomOutTimeline);
  const toggleMarkerAtCurrent = usePlaybackStore((s) => s.toggleMarkerAtCurrent);
  const jumpToPrevMarker = usePlaybackStore((s) => s.jumpToPrevMarker);
  const jumpToNextMarker = usePlaybackStore((s) => s.jumpToNextMarker);
  const setActivePanel = useSelectionStore((s) => s.setActivePanel);
  const activePanel = useSelectionStore((s) => s.activePanel);
  const currentProject = useProjectStore((s) => s.currentProject);
  const editorRef = useRef<HTMLDivElement>(null);
  const [topPaneRatio, setTopPaneRatio] = useState(0.52);
  const [sourcePaneRatio, setSourcePaneRatio] = useState(0.42);
  const [mediaPanelOpen, setMediaPanelOpen] = useState(true);
  const [inspectorPanelOpen, setInspectorPanelOpen] = useState(true);
  const splitterRef = useRef<null | 'vertical' | 'horizontal'>(null);

  // --- Razor (C key): select razor tool (sticky) ---
  const razorAtPlayhead = useCallback(() => {
    useSelectionStore.getState().setTimelineTool('razor');
  }, []);

  const cutAtPlayhead = useCallback(() => {
    const { activePanel, selectedClipIds, targetVideoTrackId, targetAudioTrackId } =
      useSelectionStore.getState();
    if (activePanel !== 'timeline') return;

    const currentFrame = usePlaybackStore.getState().currentFrame;
    const { sequences, splitClipAtPlayhead } = useProjectStore.getState();
    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];

    const selected = Array.from(selectedClipIds);
    let targetIds = selected;
    if (targetIds.length === 0) {
      const targetTrackIds = [targetVideoTrackId, targetAudioTrackId].filter(Boolean) as string[];
      const scoped =
        targetTrackIds.length > 0 ? tracks.filter((t) => targetTrackIds.includes(t.id)) : tracks;
      for (const t of scoped) {
        const hit = t.clips.find(
          (c) => currentFrame > c.startFrame && currentFrame < c.startFrame + c.durationFrames,
        );
        if (hit) targetIds.push(hit.id);
      }
      if (targetIds.length === 0) return;
    }

    const idSet = new Set<string>(targetIds);
    for (const t of tracks) {
      for (const c of t.clips) {
        if (idSet.has(c.id) && c.linkedClipId) idSet.add(c.linkedClipId);
      }
    }

    for (const id of idSet) {
      void splitClipAtPlayhead(id, currentFrame);
    }
  }, []);

  // --- Undo / Redo ---
  const handleUndo = useCallback(() => {
    useProjectStore.getState().undo();
  }, []);

  const handleRedo = useCallback(() => {
    useProjectStore.getState().redo();
  }, []);

  // --- Delete selected clips ---
  const handleDelete = useCallback((options?: { unlink?: boolean }) => {
    const {
      selectedClipIds,
      clearClipSelection,
      rippleMode,
      activePanel,
      targetVideoTrackId,
      targetAudioTrackId,
    } = useSelectionStore.getState();

    if (activePanel === 'project-browser') return;

    // Filter out clips on locked tracks
    const { sequences, extractRangeByInOut } = useProjectStore.getState();
    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];

    let targetIds = Array.from(selectedClipIds);
    if (targetIds.length === 0) {
      const currentFrame = usePlaybackStore.getState().currentFrame;
      const targetTrackIds = [targetVideoTrackId, targetAudioTrackId].filter(Boolean) as string[];
      const scoped =
        targetTrackIds.length > 0 ? tracks.filter((t) => targetTrackIds.includes(t.id)) : tracks;
      for (const t of scoped) {
        const hit = t.clips.find(
          (c) => currentFrame >= c.startFrame && currentFrame < c.startFrame + c.durationFrames,
        );
        if (hit) targetIds.push(hit.id);
      }
      if (targetIds.length === 0) {
        const unlockedTracks = tracks.filter((t) => !t.locked);
        if (unlockedTracks.length === 0) return;

        const boundaries = new Set<number>([0]);
        for (const t of unlockedTracks) {
          for (const c of t.clips) {
            boundaries.add(Math.max(0, c.startFrame));
            boundaries.add(Math.max(0, c.startFrame + c.durationFrames));
          }
        }
        const sorted = Array.from(boundaries).sort((a, b) => a - b);
        let gapStart = 0;
        let gapEnd = 0;
        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i];
          const b = sorted[i + 1];
          if (currentFrame < a || currentFrame >= b) continue;
          const overlaps = unlockedTracks.some((t) =>
            t.clips.some((c) => c.startFrame < b && c.startFrame + c.durationFrames > a),
          );
          if (!overlaps) {
            gapStart = a;
            gapEnd = b;
          }
          break;
        }

        if (gapEnd > gapStart) {
          void extractRangeByInOut(gapStart, gapEnd, {
            targetTrackIds: unlockedTracks.map((t) => t.id),
            useSyncLock: false,
          });
        }
        return;
      }
    }

    const lockedTrackClipIds = new Set<string>();
    for (const track of tracks) {
      if (track.locked) {
        for (const clip of track.clips) lockedTrackClipIds.add(clip.id);
      }
    }
    let expanded = targetIds;
    if (!options?.unlink) {
      const map = new Map<string, string | undefined>();
      for (const track of tracks) {
        for (const clip of track.clips) map.set(clip.id, clip.linkedClipId);
      }
      const all = new Set<string>(targetIds);
      for (const id of targetIds) {
        const linked = map.get(id);
        if (linked) all.add(linked);
      }
      expanded = Array.from(all);
    }

    const deletable = expanded.filter((id) => !lockedTrackClipIds.has(id));
    if (deletable.length === 0) return;

    if (rippleMode) {
      useProjectStore.getState().rippleDeleteClips(deletable);
    } else {
      useProjectStore.getState().removeClips(deletable);
    }
    clearClipSelection();
  }, []);

  const clipClipboardRef = useRef<
    Array<{
      mediaAssetId: string;
      type: 'video' | 'audio' | 'image';
      sourceInFrame?: number;
      sourceOutFrame?: number;
      startOffset: number;
      trackType: 'video' | 'audio';
      trackOffset: number;
      sourceClipId: string;
      linkedSourceClipId?: string;
      props: Partial<
        Pick<
          TimelineTrackData['clips'][number],
          | 'positionX'
          | 'positionY'
          | 'scaleX'
          | 'scaleY'
          | 'rotation'
          | 'opacity'
          | 'speed'
          | 'preservePitch'
          | 'gain'
          | 'pan'
          | 'audioGainDb'
          | 'audioVolume'
          | 'audioPan'
          | 'audioEqLow'
          | 'audioEqMid'
          | 'audioEqHigh'
          | 'audioEq63'
          | 'audioEq125'
          | 'audioEq250'
          | 'audioEq500'
          | 'audioEq1k'
          | 'audioEq2k'
          | 'audioEq4k'
          | 'audioEq8k'
          | 'brightness'
          | 'contrast'
          | 'saturation'
          | 'hue'
          | 'vignette'
        >
      >;
    }>
  >([]);
  const clipClipboardBaseFrameRef = useRef(0);

  const collectSelectedClips = useCallback(() => {
    const { sequences, mediaAssets } = useProjectStore.getState();
    const { selectedClipIds } = useSelectionStore.getState();
    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];
    const selected = new Set(selectedClipIds);
    const found: Array<{
      clipId: string;
      trackId: string;
      trackType: 'video' | 'audio';
      trackIndex: number;
      startFrame: number;
      mediaAssetId: string;
      type: 'video' | 'audio' | 'image';
      sourceInFrame?: number;
      sourceOutFrame?: number;
      durationFrames: number;
      linkedClipId?: string;
      props: Partial<
        Pick<
          TimelineTrackData['clips'][number],
          | 'positionX'
          | 'positionY'
          | 'scaleX'
          | 'scaleY'
          | 'rotation'
          | 'opacity'
          | 'speed'
          | 'preservePitch'
          | 'gain'
          | 'pan'
          | 'audioGainDb'
          | 'audioVolume'
          | 'audioPan'
          | 'audioEqLow'
          | 'audioEqMid'
          | 'audioEqHigh'
          | 'audioEq63'
          | 'audioEq125'
          | 'audioEq250'
          | 'audioEq500'
          | 'audioEq1k'
          | 'audioEq2k'
          | 'audioEq4k'
          | 'audioEq8k'
          | 'brightness'
          | 'contrast'
          | 'saturation'
          | 'hue'
          | 'vignette'
        >
      >;
    }> = [];

    for (const track of tracks) {
      for (const clip of track.clips) {
        if (!selected.has(clip.id)) continue;
        if (!clip.mediaAssetId) continue;
        const media = mediaAssets.find((m) => m.id === clip.mediaAssetId);
        if (!media) continue;
        found.push({
          clipId: clip.id,
          trackId: track.id,
          trackType: track.type,
          trackIndex: track.index,
          startFrame: clip.startFrame,
          mediaAssetId: clip.mediaAssetId,
          type: media.type,
          sourceInFrame: clip.sourceInFrame,
          sourceOutFrame: clip.sourceOutFrame,
          durationFrames: clip.durationFrames,
          linkedClipId: clip.linkedClipId,
          props: {
            positionX: clip.positionX,
            positionY: clip.positionY,
            scaleX: clip.scaleX,
            scaleY: clip.scaleY,
            rotation: clip.rotation,
            opacity: clip.opacity,
            speed: clip.speed,
            preservePitch: clip.preservePitch,
            gain: clip.gain,
            pan: clip.pan,
            audioGainDb: clip.audioGainDb,
            audioVolume: clip.audioVolume,
            audioPan: clip.audioPan,
            audioEqLow: clip.audioEqLow,
            audioEqMid: clip.audioEqMid,
            audioEqHigh: clip.audioEqHigh,
            audioEq63: clip.audioEq63,
            audioEq125: clip.audioEq125,
            audioEq250: clip.audioEq250,
            audioEq500: clip.audioEq500,
            audioEq1k: clip.audioEq1k,
            audioEq2k: clip.audioEq2k,
            audioEq4k: clip.audioEq4k,
            audioEq8k: clip.audioEq8k,
            brightness: clip.brightness,
            contrast: clip.contrast,
            saturation: clip.saturation,
            hue: clip.hue,
            vignette: clip.vignette,
          },
        });
      }
    }
    return found;
  }, []);

  const copySelectionToClipboard = useCallback(
    (selected: ReturnType<typeof collectSelectedClips>) => {
      if (selected.length === 0) {
        clipClipboardRef.current = [];
        return;
      }
      const minStart = Math.min(...selected.map((s) => s.startFrame));
      const minVideoTrackIndex = Math.min(
        ...selected.filter((s) => s.trackType === 'video').map((s) => s.trackIndex),
        Number.POSITIVE_INFINITY,
      );
      const minAudioTrackIndex = Math.min(
        ...selected.filter((s) => s.trackType === 'audio').map((s) => s.trackIndex),
        Number.POSITIVE_INFINITY,
      );
      clipClipboardRef.current = selected.map((s) => ({
        mediaAssetId: s.mediaAssetId,
        type: s.type,
        sourceInFrame: s.sourceInFrame,
        sourceOutFrame: s.sourceOutFrame,
        startOffset: s.startFrame - minStart,
        trackType: s.trackType,
        trackOffset:
          s.trackType === 'audio'
            ? s.trackIndex -
              (Number.isFinite(minAudioTrackIndex) ? minAudioTrackIndex : s.trackIndex)
            : s.trackIndex -
              (Number.isFinite(minVideoTrackIndex) ? minVideoTrackIndex : s.trackIndex),
        sourceClipId: s.clipId,
        linkedSourceClipId: s.linkedClipId,
        props: s.props,
      }));
      clipClipboardBaseFrameRef.current = minStart;
    },
    [collectSelectedClips],
  );

  const pasteClipboardAtFrame = useCallback(async (baseFrame: number) => {
    const items = clipClipboardRef.current;
    if (!items.length) return;

    const { sequences, mediaAssets, addClipToTrack, updateClipProperties } =
      useProjectStore.getState();
    const { targetVideoTrackId, targetAudioTrackId, clearClipSelection, selectClip } =
      useSelectionStore.getState();
    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];
    if (!tracks.length) return;

    const videoTracks = tracks.filter((t) => t.type === 'video').sort((a, b) => a.index - b.index);
    const audioTracks = tracks.filter((t) => t.type === 'audio').sort((a, b) => a.index - b.index);

    const resolveTrackId = (item: (typeof items)[number]): string | null => {
      const pool = item.trackType === 'audio' ? audioTracks : videoTracks;
      if (!pool.length) return null;
      const anchorId = item.trackType === 'audio' ? targetAudioTrackId : targetVideoTrackId;
      const anchorIdx = anchorId ? pool.findIndex((t) => t.id === anchorId) : 0;
      const resolvedIdx = Math.max(
        0,
        Math.min(pool.length - 1, Math.max(0, anchorIdx) + item.trackOffset),
      );
      return pool[resolvedIdx]?.id ?? pool[0].id;
    };

    const insertedIds: string[] = [];
    const pastedBySourceId = new Map<string, string>();

    for (const item of items) {
      const asset = mediaAssets.find((m) => m.id === item.mediaAssetId);
      if (!asset) continue;
      const trackId = resolveTrackId(item);
      if (!trackId) continue;

      const beforeData = (useProjectStore.getState().sequences[0]?.data as
        | { tracks?: TimelineTrackData[] }
        | undefined) ?? { tracks: [] };
      const beforeTrack = (beforeData.tracks ?? []).find((t) => t.id === trackId);
      const beforeIds = new Set((beforeTrack?.clips ?? []).map((c) => c.id));

      await addClipToTrack({
        trackId,
        asset,
        startFrame: Math.max(0, baseFrame + item.startOffset),
        sourceInFrame: item.sourceInFrame,
        sourceOutFrame: item.sourceOutFrame,
        insertMode: 'overwrite',
      });

      const afterData = (useProjectStore.getState().sequences[0]?.data as
        | { tracks?: TimelineTrackData[] }
        | undefined) ?? { tracks: [] };
      const afterTrack = (afterData.tracks ?? []).find((t) => t.id === trackId);
      const inserted = (afterTrack?.clips ?? []).find((c) => !beforeIds.has(c.id));
      if (!inserted) continue;

      insertedIds.push(inserted.id);
      pastedBySourceId.set(item.sourceClipId, inserted.id);

      if (Object.values(item.props).some((v) => v != null)) {
        await updateClipProperties(inserted.id, item.props);
      }
    }

    for (const item of items) {
      if (!item.linkedSourceClipId) continue;
      const newId = pastedBySourceId.get(item.sourceClipId);
      const newLinkedId = pastedBySourceId.get(item.linkedSourceClipId);
      if (!newId || !newLinkedId) continue;
      await updateClipProperties(newId, { linkedClipId: newLinkedId });
    }

    clearClipSelection();
    for (const id of insertedIds) {
      selectClip(id, true);
    }
  }, []);

  const nudgeSelectedClips = useCallback(
    (frameDelta: number, trackDelta: -1 | 1 | 0) => {
      const { sequences, moveClip } = useProjectStore.getState();
      const { activePanel } = useSelectionStore.getState();
      if (activePanel !== 'timeline') return;
      const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
      const tracks = data?.tracks ?? [];
      if (!tracks.length) return;

      const selected = collectSelectedClips();
      if (selected.length === 0) return;

      for (const item of selected) {
        let targetTrackId = item.trackId;
        if (trackDelta !== 0) {
          const sameType = tracks
            .filter((t) => t.type === item.trackType)
            .sort((a, b) => a.index - b.index);
          const idx = sameType.findIndex((t) => t.id === item.trackId);
          if (idx >= 0) {
            const nextIdx = Math.max(0, Math.min(sameType.length - 1, idx + trackDelta));
            targetTrackId = sameType[nextIdx]?.id ?? item.trackId;
          }
        }
        void moveClip(item.clipId, targetTrackId, Math.max(0, item.startFrame + frameDelta), {
          unlink: true,
        });
      }
    },
    [collectSelectedClips],
  );

  const trimDeleteAtPlayhead = useCallback((side: 'before' | 'after') => {
    const { sequences, trimClip, extractRangeByInOut } = useProjectStore.getState();
    const { selectedClipIds, rippleMode } = useSelectionStore.getState();
    const { currentFrame } = usePlaybackStore.getState();
    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];

    let targetClip: {
      id: string;
      startFrame: number;
      durationFrames: number;
      locked: boolean;
    } | null = null;

    if (selectedClipIds.size > 0) {
      const selected = Array.from(selectedClipIds);
      outer: for (const track of tracks) {
        for (const clip of track.clips) {
          if (selected.includes(clip.id)) {
            targetClip = {
              id: clip.id,
              startFrame: clip.startFrame,
              durationFrames: clip.durationFrames,
              locked: track.locked,
            };
            break outer;
          }
        }
      }
    }

    if (!targetClip) {
      outer: for (const track of tracks) {
        if (track.locked) continue;
        for (const clip of track.clips) {
          if (
            currentFrame > clip.startFrame &&
            currentFrame < clip.startFrame + clip.durationFrames
          ) {
            targetClip = {
              id: clip.id,
              startFrame: clip.startFrame,
              durationFrames: clip.durationFrames,
              locked: false,
            };
            break outer;
          }
        }
      }
    }

    if (!targetClip || targetClip.locked) return;

    const clipEnd = targetClip.startFrame + targetClip.durationFrames;
    if (currentFrame <= targetClip.startFrame || currentFrame >= clipEnd) return;

    const rangeStart = side === 'before' ? targetClip.startFrame : currentFrame;
    const rangeEnd = side === 'before' ? currentFrame : clipEnd;

    if (rippleMode) {
      const unlockedIds = tracks.filter((t) => !t.locked).map((t) => t.id);
      if (unlockedIds.length === 0) return;
      void extractRangeByInOut(rangeStart, rangeEnd, {
        targetTrackIds: unlockedIds,
        useSyncLock: false,
      });
      return;
    }

    if (side === 'before') {
      const newStart = currentFrame;
      const newDuration = clipEnd - currentFrame;
      void trimClip(targetClip.id, newStart, newDuration);
    } else {
      const newDuration = currentFrame - targetClip.startFrame;
      void trimClip(targetClip.id, targetClip.startFrame, newDuration);
    }
  }, []);

  const jumpToCutPoint = useCallback((dir: 'prev' | 'next') => {
    const { sequences } = useProjectStore.getState();
    const { currentFrame, setCurrentFrame } = usePlaybackStore.getState();
    const { targetVideoTrackId, targetAudioTrackId } = useSelectionStore.getState();

    const data = sequences[0]?.data as { tracks?: TimelineTrackData[] } | undefined;
    const tracks = data?.tracks ?? [];
    if (!tracks.length) return;

    const activeTargetIds = [targetVideoTrackId, targetAudioTrackId].filter(Boolean) as string[];
    const targetSet = new Set(activeTargetIds);
    const scopedTracks = targetSet.size > 0 ? tracks.filter((t) => targetSet.has(t.id)) : tracks;

    const points = new Set<number>();
    for (const track of scopedTracks) {
      for (const clip of track.clips) {
        points.add(Math.max(0, clip.startFrame));
        points.add(Math.max(0, clip.startFrame + clip.durationFrames));
      }
    }

    const sorted = Array.from(points).sort((a, b) => a - b);
    if (!sorted.length) return;

    if (dir === 'prev') {
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i] < currentFrame) {
          setCurrentFrame(sorted[i]);
          return;
        }
      }
      setCurrentFrame(sorted[0]);
      return;
    }

    for (const p of sorted) {
      if (p > currentFrame) {
        setCurrentFrame(p);
        return;
      }
    }
    setCurrentFrame(sorted[sorted.length - 1]);
  }, []);

  const keyActions: KeyboardActions = useMemo(
    () => ({
      onStepForward: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'timeline' || panel === 'program-monitor') stepForward();
      },
      onStepBackward: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'timeline' || panel === 'program-monitor') stepBackward();
      },
      onStepForward10: () => {
        if (useSelectionStore.getState().activePanel !== 'timeline') return;
        const pb = usePlaybackStore.getState();
        pb.setCurrentFrame(pb.currentFrame + 10);
      },
      onStepBackward10: () => {
        if (useSelectionStore.getState().activePanel !== 'timeline') return;
        const pb = usePlaybackStore.getState();
        pb.setCurrentFrame(Math.max(0, pb.currentFrame - 10));
      },
      onJumpToPrevCut: () => {
        if (useSelectionStore.getState().activePanel === 'timeline') jumpToCutPoint('prev');
      },
      onJumpToNextCut: () => {
        if (useSelectionStore.getState().activePanel === 'timeline') jumpToCutPoint('next');
      },
      onGoToStart: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'timeline' || panel === 'program-monitor') goToStart();
      },
      onGoToEnd: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'timeline' || panel === 'program-monitor') goToEnd();
      },
      onSetInPoint: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('mark-in');
          return;
        }
        setInPoint();
      },
      onSetOutPoint: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('mark-out');
          return;
        }
        setOutPoint();
      },
      onRazor: razorAtPlayhead,
      onCutAtPlayhead: cutAtPlayhead,
      onUndo: handleUndo,
      onRedo: handleRedo,
      onDelete: handleDelete,
      onZoomIn: () => {
        if (useSelectionStore.getState().activePanel === 'timeline') zoomInTimeline();
      },
      onZoomOut: () => {
        if (useSelectionStore.getState().activePanel === 'timeline') zoomOutTimeline();
      },
      onFitTimeline: () => {
        if (useSelectionStore.getState().activePanel === 'timeline') {
          dispatchTimelineCommand('fit-all');
        }
      },
      onZoomToFrame: () => {
        if (useSelectionStore.getState().activePanel === 'timeline') {
          dispatchTimelineCommand('zoom-to-frame');
        }
      },
      onImportMedia: () => {
        setMediaPanelOpen(true);
        setActivePanel('project-browser');
        dispatchMediaImportOpen();
      },
      onFocusMedia: () => {
        setMediaPanelOpen(true);
        setActivePanel('project-browser');
      },
      onFocusSource: () => setActivePanel('source-monitor'),
      onFocusTimeline: () => setActivePanel('timeline'),
      onFocusProgram: () => setActivePanel('program-monitor'),
      onFocusInspector: () => {
        setInspectorPanelOpen(true);
        setActivePanel('inspector');
      },
      onSelectTool: () => useSelectionStore.getState().setTimelineTool('select'),
      onToggleRippleMode: () => {
        const sel = useSelectionStore.getState();
        if (sel.activePanel !== 'timeline') return;
        sel.setRippleMode(!sel.rippleMode);
      },
      onInsertAction: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('insert');
          return;
        }
        if (panel === 'program-monitor') {
          const pb = usePlaybackStore.getState();
          if (pb.inPoint == null || pb.outPoint == null) return;
          void useProjectStore.getState().liftRangeByInOut(pb.inPoint, pb.outPoint);
        }
      },
      onOverwriteAction: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('overwrite');
          return;
        }
        if (panel === 'program-monitor') {
          const pb = usePlaybackStore.getState();
          if (pb.inPoint == null || pb.outPoint == null) return;
          void useProjectStore.getState().extractRangeByInOut(pb.inPoint, pb.outPoint);
        }
      },
      onSourceZoomIn: () => {
        if (useSelectionStore.getState().activePanel === 'source-monitor') {
          dispatchSourceCommand('zoom-in');
        }
      },
      onSourceZoomOut: () => {
        if (useSelectionStore.getState().activePanel === 'source-monitor') {
          dispatchSourceCommand('zoom-out');
        }
      },
      onAltArrowLeft: () => nudgeSelectedClips(-1, 0),
      onAltArrowRight: () => nudgeSelectedClips(1, 0),
      onAltArrowUp: () => nudgeSelectedClips(0, -1),
      onAltArrowDown: () => nudgeSelectedClips(0, 1),
      onCopy: () => {
        if (useSelectionStore.getState().activePanel !== 'timeline') return;
        const selected = collectSelectedClips();
        if (selected.length === 0) return;
        copySelectionToClipboard(selected);
      },
      onCut: () => {
        if (useSelectionStore.getState().activePanel === 'timeline') {
          const selected = collectSelectedClips();
          if (selected.length === 0) return;
          copySelectionToClipboard(selected);
          handleDelete();
        }
      },
      onPaste: () => {
        if (useSelectionStore.getState().activePanel !== 'timeline') return;
        const currentFrame = usePlaybackStore.getState().currentFrame;
        void pasteClipboardAtFrame(currentFrame);
      },
      onPasteInPlace: () => {
        if (useSelectionStore.getState().activePanel !== 'timeline') return;
        void pasteClipboardAtFrame(clipClipboardBaseFrameRef.current);
      },
      onDuplicate: () => {
        if (useSelectionStore.getState().activePanel !== 'timeline') return;
        const selected = collectSelectedClips();
        if (selected.length === 0) return;
        copySelectionToClipboard(selected);
        const maxEnd = Math.max(...selected.map((s) => s.startFrame + s.durationFrames));
        void pasteClipboardAtFrame(maxEnd + 1);
      },
      onTrimDeleteBefore: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('trim-before');
        } else {
          trimDeleteAtPlayhead('before');
        }
      },
      onTrimDeleteAfter: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('trim-after');
        } else {
          trimDeleteAtPlayhead('after');
        }
      },
      onPlayPause: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('play-pause');
          return;
        }
        togglePlayPause();
      },
      onShuttleForward: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('jkl-forward');
          return;
        }
        shuttleForward();
      },
      onShuttleReverse: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('jkl-reverse');
          return;
        }
        shuttleReverse();
      },
      onShuttlePause: () => {
        const panel = useSelectionStore.getState().activePanel;
        if (panel === 'source-monitor') {
          dispatchSourceCommand('jkl-pause');
          return;
        }
        shuttlePause();
      },
      onToggleMarker: toggleMarkerAtCurrent,
      onPrevMarker: jumpToPrevMarker,
      onNextMarker: jumpToNextMarker,
    }),
    [
      togglePlayPause,
      stepForward,
      stepBackward,
      goToStart,
      goToEnd,
      setInPoint,
      setOutPoint,
      shuttleForward,
      shuttleReverse,
      shuttlePause,
      razorAtPlayhead,
      handleUndo,
      handleRedo,
      handleDelete,
      zoomInTimeline,
      zoomOutTimeline,
      trimDeleteAtPlayhead,
      toggleMarkerAtCurrent,
      jumpToPrevMarker,
      jumpToNextMarker,
      jumpToCutPoint,
      collectSelectedClips,
      handleDelete,
      nudgeSelectedClips,
      setActivePanel,
    ],
  );

  useKeyboard(keyActions);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const mode = splitterRef.current;
      if (!mode) return;
      const editor = editorRef.current;
      if (!editor) return;
      const rect = editor.getBoundingClientRect();

      if (mode === 'vertical') {
        const y = e.clientY - rect.top;
        const ratio = Math.max(0.2, Math.min(0.8, y / Math.max(1, rect.height)));
        setTopPaneRatio(ratio);
      } else {
        const x = e.clientX - rect.left;
        const ratio = Math.max(0.2, Math.min(0.8, x / Math.max(1, rect.width)));
        setSourcePaneRatio(ratio);
      }
    };

    const onUp = () => {
      splitterRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!currentProject) {
    return (
      <div className="flex h-screen w-screen flex-col bg-zinc-900 text-zinc-100">
        <Header />
        <ProjectsScreen />
        <StatusBar />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-zinc-900 text-zinc-100">
      <Header />

      <main className="flex flex-1 overflow-hidden">
        {mediaPanelOpen ? (
          <div
            className={`flex ${activePanel === 'project-browser' ? 'ring-1 ring-inset ring-blue-500/70' : ''}`}
            onMouseDown={() => setActivePanel('project-browser')}
          >
            <ProjectBrowser onToggleCollapse={() => setMediaPanelOpen(false)} />
          </div>
        ) : (
          <div
            className={`flex w-8 flex-shrink-0 flex-col items-center border-r border-zinc-700 bg-zinc-800/40 py-2 ${activePanel === 'project-browser' ? 'ring-1 ring-inset ring-blue-500/70' : ''}`}
          >
            <button
              className="rounded bg-zinc-700 px-1.5 py-1 text-[10px] text-zinc-200 hover:bg-zinc-600"
              onClick={() => setMediaPanelOpen(true)}
              title="Open media panel"
            >
              ▶
            </button>
            <span className="mt-2 [writing-mode:vertical-rl] rotate-180 text-[10px] uppercase tracking-wider text-zinc-500">
              Media
            </span>
          </div>
        )}

        <div ref={editorRef} className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Monitors */}
          <div
            className="flex min-h-0 overflow-hidden border-b border-zinc-700"
            style={{ height: `${topPaneRatio * 100}%` }}
          >
            <div
              className="flex min-h-0 min-w-0 overflow-hidden border-r border-zinc-700"
              style={{ width: `${sourcePaneRatio * 100}%` }}
            >
              <div
                className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${activePanel === 'source-monitor' ? 'ring-1 ring-inset ring-blue-500/70' : ''}`}
                onMouseDown={() => setActivePanel('source-monitor')}
              >
                <SourceMonitor />
              </div>
            </div>
            <div
              className="w-1 cursor-col-resize bg-zinc-800 hover:bg-zinc-600"
              onMouseDown={() => {
                splitterRef.current = 'horizontal';
              }}
            />
            <div className="flex min-h-0 flex-1 min-w-0 overflow-hidden">
              <div
                className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${activePanel === 'program-monitor' ? 'ring-1 ring-inset ring-blue-500/70' : ''}`}
                onMouseDown={() => setActivePanel('program-monitor')}
              >
                <ProgramMonitor />
              </div>
            </div>
          </div>

          <div
            className="h-1 cursor-row-resize bg-zinc-800 hover:bg-zinc-600"
            onMouseDown={() => {
              splitterRef.current = 'vertical';
            }}
          />

          {/* Timeline */}
          <div
            className={`min-h-0 flex-1 ${activePanel === 'timeline' ? 'ring-1 ring-inset ring-blue-500/70' : ''}`}
            onMouseDown={() => setActivePanel('timeline')}
            style={{ height: `${(1 - topPaneRatio) * 100}%` }}
          >
            <Timeline />
          </div>
        </div>

        {inspectorPanelOpen ? (
          <div
            className={`flex ${activePanel === 'inspector' ? 'ring-1 ring-inset ring-blue-500/70' : ''}`}
            onMouseDown={() => setActivePanel('inspector')}
          >
            <Inspector onToggleCollapse={() => setInspectorPanelOpen(false)} />
          </div>
        ) : (
          <div
            className={`flex w-8 flex-shrink-0 flex-col items-center border-l border-zinc-700 bg-zinc-800/40 py-2 ${activePanel === 'inspector' ? 'ring-1 ring-inset ring-blue-500/70' : ''}`}
          >
            <button
              className="rounded bg-zinc-700 px-1.5 py-1 text-[10px] text-zinc-200 hover:bg-zinc-600"
              onClick={() => setInspectorPanelOpen(true)}
              title="Open inspector panel"
            >
              ◀
            </button>
            <span className="mt-2 [writing-mode:vertical-rl] rotate-180 text-[10px] uppercase tracking-wider text-zinc-500">
              Inspector
            </span>
          </div>
        )}
      </main>

      <StatusBar />
    </div>
  );
}
