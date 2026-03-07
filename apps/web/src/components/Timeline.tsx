/**
 * Timeline panel â€” the core editing surface.
 *
 * Shows track headers, clip blocks, playhead, and time ruler.
 * Supports drag-and-drop from project browser, clip selection,
 * clip move (drag), clip trimming (edge drag), and playhead scrub.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import type { ApiMediaAsset } from '../lib/api.js';
import type { TimelineMarker } from '../stores/playbackStore.js';
import { api } from '../lib/api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/** Accepted media file extensions for drop detection. */
const MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.m4v',
  '.wmv',
  '.flv',
  '.mp3',
  '.wav',
  '.aac',
  '.ogg',
  '.flac',
  '.m4a',
  '.aiff',
  '.aif',
  '.alac',
  '.opus',
  '.ac3',
  '.eac3',
  '.dts',
  '.amr',
  '.ape',
  '.mp2',
  '.pcm',
  '.caf',
  '.au',
  '.wma',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.tif',
]);

/** Pixels per frame at zoom level 1.0 */
const BASE_PX_PER_FRAME = 4;

const TRACK_HEIGHT = 56;
const RULER_HEIGHT = 24; // px
const SNAP_THRESHOLD_PX = 8; // px distance for snapping

interface TimelineTrack {
  id: string;
  name: string;
  type: 'video' | 'audio';
  index: number;
  clips: TimelineClip[];
  muted: boolean;
  locked: boolean;
  syncLocked?: boolean;
  solo?: boolean;
  channelMode?: 'stereo' | 'mono';
  channelMap?: 'L+R' | 'L' | 'R';
}

interface TimelineClip {
  id: string;
  name: string;
  type: string;
  startFrame: number;
  durationFrames: number;
  mediaAssetId?: string | null;
  sourceInFrame?: number;
  sourceOutFrame?: number;
  speed?: number;
  gain?: number;
  pan?: number;
  audioGainDb?: number;
  audioVolume?: number;
  keyframes?: Array<{
    id: string;
    frame: number;
    property: string;
    value: number;
  }>;
  blendMode?: string;
  transitionIn?: { id: string; type: string; durationFrames: number } | null;
  transitionOut?: { id: string; type: string; durationFrames: number } | null;
  generator?: { kind: 'black-video' | 'color-matte' | 'adjustment-layer'; color?: string } | null;
}

// Drag/Trim interaction state
interface DragState {
  mode: 'move' | 'trim-left' | 'trim-right';
  clipId: string;
  trackId: string;
  origStartFrame: number;
  origDurationFrames: number;
  sourceInFrame?: number;
  sourceOutFrame?: number;
  mediaAssetId?: string | null;
  copyOnDrag?: boolean;
  startX: number; // mouse X at drag start
}

/** Extract fps from first sequence metadata, default 30. */
function getSequenceFps(sequences: Array<{ frameRate?: { num?: number; den?: number } }>): number {
  if (!sequences.length) return 30;
  const fr = sequences[0]?.frameRate;
  if (!fr || !fr.num || !fr.den) return 30;
  return fr.num / fr.den;
}

/**
 * Compute snap for a target frame against all clip edges and the playhead.
 * Returns the snapped frame and a flag indicating if snapping occurred.
 */
function computeSnap(
  targetFrame: number,
  excludeClipId: string,
  tracks: TimelineTrack[],
  playheadFrame: number,
  markers: TimelineMarker[],
  pxPerFrame: number,
): { frame: number; snapped: boolean } {
  const thresholdFrames = SNAP_THRESHOLD_PX / pxPerFrame;
  let bestFrame = targetFrame;
  let bestDist = Infinity;

  // Snap targets: all clip start/end + playhead
  const targets: number[] = [playheadFrame, ...markers.map((m) => m.frame)];
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      targets.push(clip.startFrame);
      targets.push(clip.startFrame + clip.durationFrames);
    }
  }

  for (const t of targets) {
    const dist = Math.abs(targetFrame - t);
    if (dist < thresholdFrames && dist < bestDist) {
      bestDist = dist;
      bestFrame = t;
    }
  }

  return { frame: bestFrame, snapped: bestDist < Infinity && bestDist < thresholdFrames };
}

export function Timeline() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const sequences = useProjectStore((s) => s.sequences);
  const uploadMedia = useProjectStore((s) => s.uploadMedia);
  const addClipToTrack = useProjectStore((s) => s.addClipToTrack);
  const addGeneratorClip = useProjectStore((s) => s.addGeneratorClip);
  const updateProjectSettings = useProjectStore((s) => s.updateProjectSettings);
  const addTrack = useProjectStore((s) => s.addTrack);
  const mediaAssets = useProjectStore((s) => s.mediaAssets);
  const moveClip = useProjectStore((s) => s.moveClip);
  const trimClip = useProjectStore((s) => s.trimClip);
  const rippleTrimClip = useProjectStore((s) => s.rippleTrimClip);
  const splitClipAtPlayhead = useProjectStore((s) => s.splitClipAtPlayhead);
  const updateTrack = useProjectStore((s) => s.updateTrack);
  const isTrackLocked = useProjectStore((s) => s.isTrackLocked);
  const unlinkSelectedClips = useProjectStore((s) => s.unlinkSelectedClips);
  const relinkSelectedClips = useProjectStore((s) => s.relinkSelectedClips);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const setCurrentFrame = usePlaybackStore((s) => s.setCurrentFrame);
  const inPoint = usePlaybackStore((s) => s.inPoint);
  const outPoint = usePlaybackStore((s) => s.outPoint);
  const markers = usePlaybackStore((s) => s.markers);
  const toggleMarkerAtCurrent = usePlaybackStore((s) => s.toggleMarkerAtCurrent);
  const jumpToPrevMarker = usePlaybackStore((s) => s.jumpToPrevMarker);
  const jumpToNextMarker = usePlaybackStore((s) => s.jumpToNextMarker);
  const removeMarker = usePlaybackStore((s) => s.removeMarker);
  const updateMarker = usePlaybackStore((s) => s.updateMarker);
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const timelineTool = useSelectionStore((s) => s.timelineTool);
  const rippleMode = useSelectionStore((s) => s.rippleMode);
  const linkedSelection = useSelectionStore((s) => s.linkedSelection);
  const setTimelineTool = useSelectionStore((s) => s.setTimelineTool);
  const setRippleMode = useSelectionStore((s) => s.setRippleMode);
  const setLinkedSelection = useSelectionStore((s) => s.setLinkedSelection);
  const targetVideoTrackId = useSelectionStore((s) => s.targetVideoTrackId);
  const targetAudioTrackId = useSelectionStore((s) => s.targetAudioTrackId);
  const setTargetVideoTrackId = useSelectionStore((s) => s.setTargetVideoTrackId);
  const setTargetAudioTrackId = useSelectionStore((s) => s.setTargetAudioTrackId);
  const selectClip = useSelectionStore((s) => s.selectClip);
  const clearClipSelection = useSelectionStore((s) => s.clearClipSelection);
  const setActivePanel = useSelectionStore((s) => s.setActivePanel);

  const zoom = usePlaybackStore((s) => s.timelineZoom);
  const audioMeterLeft = usePlaybackStore((s) => s.audioMeterLeft);
  const audioMeterRight = usePlaybackStore((s) => s.audioMeterRight);
  const setTimelineZoom = usePlaybackStore((s) => s.setTimelineZoom);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);
  const [channelConfigTrackId, setChannelConfigTrackId] = useState<string | null>(null);
  const [firstClipPrompt, setFirstClipPrompt] = useState<{
    asset: ApiMediaAsset;
    trackId: string;
    startFrame: number;
    sourceInFrame?: number;
    sourceOutFrame?: number;
    insertMode: 'overwrite' | 'ripple';
    message: string;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const syncingScrollRef = useRef(false);
  const prevZoomRef = useRef(zoom);
  const skipZoomAnchorRef = useRef(false);

  // Clip move / trim interaction
  const dragRef = useRef<DragState | null>(null);
  const [dragDelta, setDragDelta] = useState(0); // px offset during drag

  // Snap line state (null = no snap line visible)
  const [snapLineFrame, setSnapLineFrame] = useState<number | null>(null);

  // Ripple indicator (Alt key held during drag)
  const [isRipple, setIsRipple] = useState(false);
  const marqueeRef = useRef<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    moved: boolean;
  } | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  // Playhead scrub interaction
  const isScrubbingRef = useRef(false);

  const pxPerFrame = BASE_PX_PER_FRAME * zoom;
  const fps = getSequenceFps(sequences);

  useEffect(() => {
    const container = containerRef.current;
    const prevZoom = prevZoomRef.current;
    if (!container || prevZoom === zoom) return;

    if (skipZoomAnchorRef.current) {
      skipZoomAnchorRef.current = false;
      prevZoomRef.current = zoom;
      return;
    }

    const oldPxPerFrame = BASE_PX_PER_FRAME * prevZoom;
    const newPxPerFrame = BASE_PX_PER_FRAME * zoom;
    const currentScreenX = currentFrame * oldPxPerFrame - container.scrollLeft;
    const nextScrollLeft = currentFrame * newPxPerFrame - currentScreenX;
    container.scrollLeft = Math.max(0, nextScrollLeft);
    prevZoomRef.current = zoom;
  }, [zoom, currentFrame]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isPlaying) return;
    if (isScrubbingRef.current) return;

    const playheadX = currentFrame * pxPerFrame;
    const left = container.scrollLeft;
    const right = left + container.clientWidth;
    const edgePadding = 72;

    if (playheadX > right - edgePadding) {
      container.scrollLeft = Math.max(0, playheadX - container.clientWidth * 0.35);
    } else if (playheadX < left + edgePadding) {
      container.scrollLeft = Math.max(0, playheadX - container.clientWidth * 0.65);
    }
  }, [isPlaying, currentFrame, pxPerFrame]);

  // Sync fps to playbackStore whenever it changes
  useEffect(() => {
    usePlaybackStore.getState().setFps(fps);
  }, [fps]);

  // Parse tracks from sequence data (MVP: use first sequence)
  const tracks: TimelineTrack[] = (() => {
    if (!sequences.length) return [];
    const data = sequences[0]?.data as { tracks?: TimelineTrack[] } | undefined;
    return data?.tracks ?? [];
  })();

  const resolveTargetVideoTrackId = useCallback((): string | null => {
    const unlocked = tracks.filter((t) => t.type === 'video' && !t.locked);
    if (unlocked.length === 0) return null;
    if (targetVideoTrackId && unlocked.some((t) => t.id === targetVideoTrackId)) {
      return targetVideoTrackId;
    }
    const preferred =
      unlocked.find((t) => t.name.trim().toUpperCase() === 'V1') ??
      [...unlocked].sort((a, b) => a.index - b.index)[0];
    return preferred?.id ?? null;
  }, [tracks, targetVideoTrackId]);

  const maybePromptFirstClipProjectMatch = useCallback(
    (
      asset: ApiMediaAsset,
      placement: {
        trackId: string;
        startFrame: number;
        sourceInFrame?: number;
        sourceOutFrame?: number;
        insertMode: 'overwrite' | 'ripple';
      },
    ): boolean => {
      const isFirstClip = tracks.every((t) => t.clips.length === 0);
      if (!isFirstClip) return false;
      const seq = sequences[0];
      if (!seq) return false;
      if (asset.type !== 'video' && asset.type !== 'image') return false;
      if (!asset.resolution) return false;

      const seqRes = seq.resolution;
      const seqFps = seq.frameRate.num / seq.frameRate.den;
      const clipFps = asset.frameRate ? asset.frameRate.num / asset.frameRate.den : null;
      const resolutionMismatch =
        asset.resolution.width !== seqRes.width || asset.resolution.height !== seqRes.height;
      const fpsMismatch = clipFps != null && Math.abs(clipFps - seqFps) > 0.01;

      if (!resolutionMismatch && !fpsMismatch) return false;

      const mismatchParts = [
        resolutionMismatch
          ? `Resolution clip ${asset.resolution.width}x${asset.resolution.height} vs project ${seqRes.width}x${seqRes.height}`
          : null,
        fpsMismatch && clipFps != null
          ? `FPS clip ${clipFps.toFixed(3)} vs project ${seqFps.toFixed(3)}`
          : null,
      ].filter(Boolean);

      setFirstClipPrompt({
        asset,
        ...placement,
        message: `${mismatchParts.join(' | ')}. Match project settings to first clip?`,
      });
      return true;
    },
    [tracks, sequences],
  );

  useEffect(() => {
    const videoTracks = tracks.filter((t) => t.type === 'video' && !t.locked);
    const audioTracks = tracks.filter((t) => t.type === 'audio' && !t.locked);

    if (videoTracks.length > 0) {
      const exists = videoTracks.some((t) => t.id === targetVideoTrackId);
      if (!exists) {
        const preferred =
          videoTracks.find((t) => t.name.trim().toUpperCase() === 'V1') ??
          [...videoTracks].sort((a, b) => a.index - b.index)[0];
        setTargetVideoTrackId(preferred.id);
      }
    }

    if (audioTracks.length > 0) {
      const exists = audioTracks.some((t) => t.id === targetAudioTrackId);
      if (!exists) {
        const preferred =
          audioTracks.find((t) => t.name.trim().toUpperCase() === 'A1') ??
          [...audioTracks].sort((a, b) => a.index - b.index)[0];
        setTargetAudioTrackId(preferred.id);
      }
    }
  }, [
    tracks,
    targetVideoTrackId,
    targetAudioTrackId,
    setTargetVideoTrackId,
    setTargetAudioTrackId,
  ]);

  // Calculate total timeline width
  let maxFrame = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      const end = clip.startFrame + clip.durationFrames;
      if (end > maxFrame) maxFrame = end;
    }
  }
  const totalWidth = Math.max((maxFrame + fps * 10) * pxPerFrame, 2000);

  // Sync totalFrames to playbackStore
  useEffect(() => {
    usePlaybackStore.getState().setTotalFrames(maxFrame);
  }, [maxFrame]);

  // --- Playhead scrub helpers ---
  const scrubToX = useCallback(
    (clientX: number) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = clientX - rect.left + container.scrollLeft;
      const frame = Math.max(0, Math.round(x / pxPerFrame));
      setCurrentFrame(frame);
    },
    [pxPerFrame, setCurrentFrame],
  );

  const handlePlayheadMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isScrubbingRef.current = true;
    // Pause playback during scrub
    usePlaybackStore.getState().pause();
  }, []);

  const getTrackIdFromClientY = useCallback(
    (clientY: number): string | null => {
      const container = containerRef.current;
      if (!container || !tracks.length) return null;
      const rect = container.getBoundingClientRect();
      const y = clientY - rect.top - RULER_HEIGHT;
      const idx = Math.floor(y / TRACK_HEIGHT);
      if (idx < 0 || idx >= tracks.length) return null;
      return tracks[idx].id;
    },
    [tracks],
  );

  // Global mouse handlers for playhead scrub, clip drag, snap, and ripple
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isScrubbingRef.current) {
        scrubToX(e.clientX);
        return;
      }
      if (marqueeRef.current) {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        marqueeRef.current.currentX = e.clientX - rect.left + container.scrollLeft;
        marqueeRef.current.currentY = e.clientY - rect.top + container.scrollTop;
        const sx = marqueeRef.current.startX;
        const sy = marqueeRef.current.startY;
        const cx = marqueeRef.current.currentX;
        const cy = marqueeRef.current.currentY;
        marqueeRef.current.moved = Math.abs(cx - sx) > 4 || Math.abs(cy - sy) > 4;
        if (!marqueeRef.current.moved) return;
        setMarqueeBox({
          left: Math.min(sx, cx),
          top: Math.min(sy, cy),
          width: Math.abs(cx - sx),
          height: Math.abs(cy - sy),
        });
        return;
      }

      // Clip drag
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      setDragDelta(dx);

      // Show ripple state from mode toggle
      setIsRipple(rippleMode);

      // --- Snap computation ---
      const drag = dragRef.current;
      const rawDeltaFrames = dx / pxPerFrame;

      let edgeFrame: number; // the frame that should snap
      if (drag.mode === 'move') {
        edgeFrame = drag.origStartFrame + rawDeltaFrames; // left edge
      } else if (drag.mode === 'trim-left') {
        edgeFrame = drag.origStartFrame + rawDeltaFrames;
      } else {
        // trim-right: right edge
        edgeFrame = drag.origStartFrame + drag.origDurationFrames + rawDeltaFrames;
      }

      const snap = computeSnap(edgeFrame, drag.clipId, tracks, currentFrame, markers, pxPerFrame);
      if (snap.snapped) {
        setSnapLineFrame(snap.frame);
        // Adjust dragDelta to match snapped position
        let snappedDx: number;
        if (drag.mode === 'move' || drag.mode === 'trim-left') {
          snappedDx = (snap.frame - drag.origStartFrame) * pxPerFrame;
        } else {
          snappedDx = (snap.frame - (drag.origStartFrame + drag.origDurationFrames)) * pxPerFrame;
        }
        setDragDelta(snappedDx);
      } else {
        setSnapLineFrame(null);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      // End playhead scrub
      if (isScrubbingRef.current) {
        isScrubbingRef.current = false;
        return;
      }
      if (marqueeRef.current) {
        const m = marqueeRef.current;
        marqueeRef.current = null;
        if (!m.moved) {
          setMarqueeBox(null);
          clearClipSelection();
          return;
        }
        const left = Math.min(m.startX, m.currentX);
        const right = Math.max(m.startX, m.currentX);
        const top = Math.min(m.startY, m.currentY);
        const bottom = Math.max(m.startY, m.currentY);
        setMarqueeBox(null);

        clearClipSelection();
        tracks.forEach((track, trackIdx) => {
          const rowTop = RULER_HEIGHT + trackIdx * TRACK_HEIGHT;
          const rowBottom = rowTop + TRACK_HEIGHT;
          if (rowBottom < top || rowTop > bottom) return;
          track.clips.forEach((clip) => {
            const clipLeft = clip.startFrame * pxPerFrame;
            const clipRight = clipLeft + Math.max(4, clip.durationFrames * pxPerFrame);
            if (clipRight >= left && clipLeft <= right) selectClip(clip.id, true);
          });
        });
        return;
      }
      // End clip drag
      if (!dragRef.current) return;
      const drag = dragRef.current;
      const useRipple = rippleMode;
      const unlinkByModifier = e.altKey ? linkedSelection : !linkedSelection;
      const dx = dragDelta; // Use potentially snapped delta
      const deltaFrames = Math.round(dx / pxPerFrame);
      const targetTrackId = getTrackIdFromClientY(e.clientY) ?? drag.trackId;
      dragRef.current = null;
      setDragDelta(0);
      setSnapLineFrame(null);
      setIsRipple(false);

      if (drag.mode === 'move') {
        if (Math.abs(deltaFrames) < 1 && targetTrackId === drag.trackId) return;
        if (isTrackLocked(targetTrackId)) return;
        const newStart = Math.max(0, drag.origStartFrame + deltaFrames);
        if (drag.copyOnDrag && drag.mediaAssetId) {
          const asset = mediaAssets.find((a) => a.id === drag.mediaAssetId);
          if (asset) {
            addClipToTrack({
              trackId: targetTrackId,
              asset,
              startFrame: newStart,
              sourceInFrame: drag.sourceInFrame,
              sourceOutFrame: drag.sourceOutFrame,
              insertMode: 'overwrite',
            });
          }
        } else {
          moveClip(drag.clipId, targetTrackId, newStart, { unlink: unlinkByModifier });
        }
      } else if (drag.mode === 'trim-left') {
        if (Math.abs(deltaFrames) < 1) return;
        const maxDelta = drag.origDurationFrames - 1;
        const clampedDelta = Math.min(maxDelta, Math.max(-drag.origStartFrame, deltaFrames));
        const newStart = drag.origStartFrame + clampedDelta;
        const newDuration = drag.origDurationFrames - clampedDelta;
        if (useRipple) {
          rippleTrimClip(drag.clipId, newStart, newDuration, { unlink: unlinkByModifier });
        } else {
          trimClip(drag.clipId, newStart, newDuration, { unlink: unlinkByModifier });
        }
      } else if (drag.mode === 'trim-right') {
        if (Math.abs(deltaFrames) < 1) return;
        const newDuration = Math.max(1, drag.origDurationFrames + deltaFrames);
        if (useRipple) {
          rippleTrimClip(drag.clipId, drag.origStartFrame, newDuration, {
            unlink: unlinkByModifier,
          });
        } else {
          trimClip(drag.clipId, drag.origStartFrame, newDuration, { unlink: unlinkByModifier });
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [
    pxPerFrame,
    moveClip,
    addClipToTrack,
    mediaAssets,
    trimClip,
    rippleTrimClip,
    scrubToX,
    tracks,
    currentFrame,
    markers,
    dragDelta,
    getTrackIdFromClientY,
    rippleMode,
    linkedSelection,
    isTrackLocked,
    clearClipSelection,
    selectClip,
  ]);

  // --- Clip drag mouse down ---
  const handleClipMouseDown = useCallback(
    (clip: TimelineClip, trackId: string, mode: DragState['mode'], e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      // Prevent interaction on locked tracks
      if (isTrackLocked(trackId)) return;

      if (timelineTool === 'razor') {
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const localX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const frameOffset = Math.round(localX / pxPerFrame);
        const splitFrame = clip.startFrame + frameOffset;
        void splitClipAtPlayhead(clip.id, splitFrame);
        return;
      }

      setActivePanel('timeline');
      selectClip(clip.id, e.shiftKey || e.ctrlKey || e.metaKey);

      dragRef.current = {
        mode,
        clipId: clip.id,
        trackId,
        origStartFrame: clip.startFrame,
        origDurationFrames: clip.durationFrames,
        sourceInFrame: clip.sourceInFrame,
        sourceOutFrame: clip.sourceOutFrame,
        mediaAssetId: clip.mediaAssetId,
        copyOnDrag: mode === 'move' && e.altKey,
        startX: e.clientX,
      };
      setDragDelta(0);
    },
    [selectClip, isTrackLocked, timelineTool, pxPerFrame, splitClipAtPlayhead, setActivePanel],
  );

  // --- Click handlers ---
  const handleRulerClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollLeft;
      const frame = Math.max(0, Math.round(x / pxPerFrame));
      setCurrentFrame(frame);
      clearClipSelection();
    },
    [pxPerFrame, scrollLeft, setCurrentFrame, clearClipSelection],
  );

  const handleTrackClick = useCallback(
    (track: TimelineTrack, e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).dataset.clip !== 'true') {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + scrollLeft;
        const frame = Math.max(0, Math.round(x / pxPerFrame));

        if (timelineTool === 'razor' && !track.locked) {
          const targetClip = track.clips.find(
            (clip) => frame > clip.startFrame && frame < clip.startFrame + clip.durationFrames,
          );
          if (targetClip) {
            void splitClipAtPlayhead(targetClip.id, frame);
            return;
          }
        }

        setCurrentFrame(frame);
        clearClipSelection();
      }
    },
    [
      pxPerFrame,
      scrollLeft,
      setCurrentFrame,
      clearClipSelection,
      timelineTool,
      splitClipAtPlayhead,
    ],
  );

  // --- Drop handlers ---
  const getTrackFromDropY = useCallback(
    (e: React.DragEvent<HTMLDivElement>): TimelineTrack | null => {
      if (!tracks.length) return null;
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top - RULER_HEIGHT;
      const trackIndex = Math.floor(y / TRACK_HEIGHT);
      if (trackIndex >= 0 && trackIndex < tracks.length) return tracks[trackIndex];
      return null;
    },
    [tracks],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOverFiles(false);

      // Native OS file drops
      if (e.dataTransfer.files.length > 0) {
        const mediaFiles: File[] = [];
        for (const file of e.dataTransfer.files) {
          const ext = '.' + file.name.split('.').pop()?.toLowerCase();
          if (
            MEDIA_EXTENSIONS.has(ext) ||
            file.type.startsWith('video/') ||
            file.type.startsWith('audio/') ||
            file.type.startsWith('image/')
          ) {
            mediaFiles.push(file);
          }
        }
        if (mediaFiles.length > 0) {
          uploadMedia(mediaFiles);
          return;
        }
      }

      const sourceSegment = e.dataTransfer.getData('application/x-localcut-source-segment');
      if (sourceSegment) {
        try {
          const parsed = JSON.parse(sourceSegment) as {
            asset: ApiMediaAsset;
            sourceInFrame?: number;
            sourceOutFrame?: number;
            audioOnly?: boolean;
          };
          const effectiveAsset =
            parsed.audioOnly && parsed.asset.type === 'video'
              ? ({ ...parsed.asset, type: 'audio' } as ApiMediaAsset)
              : parsed.asset;
          let targetTrack = getTrackFromDropY(e);
          const expectedType = effectiveAsset.type === 'audio' ? 'audio' : 'video';
          if (targetTrack && targetTrack.type !== expectedType) {
            targetTrack = null;
          }
          if (!targetTrack) {
            const isAudio = effectiveAsset.type === 'audio';
            const videoTracks = tracks.filter((t) => t.type === 'video');
            const audioTracks = tracks.filter((t) => t.type === 'audio');
            const preferredVideo =
              videoTracks.find((t) => t.name.trim().toUpperCase() === 'V1') ??
              [...videoTracks].sort((a, b) => a.index - b.index)[0];
            const preferredAudio =
              audioTracks.find((t) => t.name.trim().toUpperCase() === 'A1') ??
              [...audioTracks].sort((a, b) => a.index - b.index)[0];
            targetTrack = (isAudio ? preferredAudio : preferredVideo) ?? tracks[0] ?? null;
          }
          if (!targetTrack) return;
          const container = containerRef.current;
          if (!container) return;
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left + container.scrollLeft;
          const startFrame = Math.max(0, Math.round(x / pxPerFrame));
          const placement = {
            trackId: targetTrack.id,
            startFrame,
            sourceInFrame: parsed.sourceInFrame,
            sourceOutFrame: parsed.sourceOutFrame,
            insertMode: rippleMode ? ('ripple' as const) : ('overwrite' as const),
          };
          if (!maybePromptFirstClipProjectMatch(effectiveAsset, placement)) {
            void addClipToTrack({
              trackId: placement.trackId,
              asset: effectiveAsset,
              startFrame: placement.startFrame,
              sourceInFrame: placement.sourceInFrame,
              sourceOutFrame: placement.sourceOutFrame,
              insertMode: placement.insertMode,
              audioOnly: parsed.audioOnly,
            });
          }
          return;
        } catch {
          // ignore malformed payload
        }
      }

      // Internal asset drag â€” create clip
      const assetData = e.dataTransfer.getData('application/x-localcut-asset');
      if (assetData) {
        try {
          const payload = JSON.parse(assetData) as ApiMediaAsset & { audioOnly?: boolean };
          const asset =
            payload.audioOnly && payload.type === 'video'
              ? ({ ...payload, type: 'audio' } as ApiMediaAsset)
              : (payload as ApiMediaAsset);
          let targetTrack = getTrackFromDropY(e);
          const expectedType = asset.type === 'audio' ? 'audio' : 'video';
          if (targetTrack && targetTrack.type !== expectedType) {
            targetTrack = null;
          }
          if (!targetTrack) {
            const isAudio = asset.type === 'audio';
            const videoTracks = tracks.filter((t) => t.type === 'video');
            const audioTracks = tracks.filter((t) => t.type === 'audio');
            const preferredVideo =
              videoTracks.find((t) => t.name.trim().toUpperCase() === 'V1') ??
              [...videoTracks].sort((a, b) => a.index - b.index)[0];
            const preferredAudio =
              audioTracks.find((t) => t.name.trim().toUpperCase() === 'A1') ??
              [...audioTracks].sort((a, b) => a.index - b.index)[0];
            targetTrack = (isAudio ? preferredAudio : preferredVideo) ?? tracks[0] ?? null;
          }
          if (!targetTrack) return;
          const container = containerRef.current;
          if (!container) return;
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left + container.scrollLeft;
          const startFrame = Math.max(0, Math.round(x / pxPerFrame));
          const placement = {
            trackId: targetTrack.id,
            startFrame,
            insertMode: rippleMode ? ('ripple' as const) : ('overwrite' as const),
          };
          if (!maybePromptFirstClipProjectMatch(asset, placement)) {
            void addClipToTrack({
              trackId: placement.trackId,
              asset,
              startFrame: placement.startFrame,
              insertMode: placement.insertMode,
              audioOnly: payload.audioOnly,
            });
          }
        } catch {
          /* ignore */
        }
      }
    },
    [
      uploadMedia,
      addClipToTrack,
      getTrackFromDropY,
      tracks,
      pxPerFrame,
      rippleMode,
      maybePromptFirstClipProjectMatch,
    ],
  );

  const handleDragOverTimeline = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (
      e.dataTransfer.types.includes('Files') ||
      e.dataTransfer.types.includes('application/x-localcut-asset') ||
      e.dataTransfer.types.includes('application/x-localcut-source-segment')
    ) {
      setIsDragOverFiles(true);
    }
  }, []);

  const handleDragLeaveTimeline = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOverFiles(false);
  }, []);

  const formatTimecode = (frame: number) => {
    const roundedFps = Math.round(fps);
    const totalSec = frame / roundedFps;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    const f = frame % roundedFps;
    return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
  };

  const formatViewSpan = (frames: number) => {
    const roundedFps = Math.max(1, Math.round(fps));
    const totalSec = Math.max(0, Math.round(frames / roundedFps));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  };

  const zoomAroundPlayhead = useCallback(
    (factor: number) => {
      setTimelineZoom(zoom * factor);
    },
    [zoom, setTimelineZoom],
  );

  const fitTimelineInView = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const framesToFit = Math.max(1, maxFrame);
    const targetPxPerFrame = container.clientWidth / framesToFit;
    const targetZoom = targetPxPerFrame / BASE_PX_PER_FRAME;
    skipZoomAnchorRef.current = true;
    setTimelineZoom(targetZoom);
    requestAnimationFrame(() => {
      if (containerRef.current) containerRef.current.scrollLeft = 0;
    });
  }, [maxFrame, setTimelineZoom]);

  const zoomToFrameDetail = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const targetVisibleFrames = 12;
    const targetPxPerFrame = Math.max(1, container.clientWidth / targetVisibleFrames);
    const targetZoom = targetPxPerFrame / BASE_PX_PER_FRAME;
    setTimelineZoom(targetZoom);
  }, [setTimelineZoom]);

  useEffect(() => {
    const onTimelineCommand = (ev: Event) => {
      const custom = ev as CustomEvent<{ command?: string }>;
      if (custom.detail?.command === 'fit-all') {
        fitTimelineInView();
      } else if (custom.detail?.command === 'zoom-to-frame') {
        zoomToFrameDetail();
      }
    };
    window.addEventListener('localcut:timeline-command', onTimelineCommand);
    return () => window.removeEventListener('localcut:timeline-command', onTimelineCommand);
  }, [fitTimelineInView, zoomToFrameDetail]);

  const visibleFrames =
    containerRef.current && pxPerFrame > 0 ? containerRef.current.clientWidth / pxPerFrame : 0;

  // --- Compute visual clip position adjustments during drag ---
  const getClipVisualStyle = (clip: TimelineClip) => {
    const drag = dragRef.current;
    let left = clip.startFrame * pxPerFrame;
    let width = Math.max(clip.durationFrames * pxPerFrame, 4);

    if (drag && drag.clipId === clip.id && dragDelta !== 0) {
      if (drag.mode === 'move') {
        left = Math.max(0, drag.origStartFrame * pxPerFrame + dragDelta);
      } else if (drag.mode === 'trim-left') {
        const clampedDelta = Math.min(
          drag.origDurationFrames * pxPerFrame - 4,
          Math.max(-drag.origStartFrame * pxPerFrame, dragDelta),
        );
        left = drag.origStartFrame * pxPerFrame + clampedDelta;
        width = Math.max(4, drag.origDurationFrames * pxPerFrame - clampedDelta);
      } else if (drag.mode === 'trim-right') {
        width = Math.max(4, drag.origDurationFrames * pxPerFrame + dragDelta);
      }
    }

    return { left, width };
  };

  if (!currentProject) {
    return (
      <div
        className="flex h-full min-h-0 flex-col bg-zinc-900"
        onDrop={handleDrop}
        onDragOver={handleDragOverTimeline}
        onDragLeave={handleDragLeaveTimeline}
      >
        <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Timeline
          </span>
          <span className="font-mono text-xs text-zinc-500">00:00:00:00</span>
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">
          Open a project to start editing
        </div>

        <div className="w-20 flex-shrink-0 border-l border-zinc-700 bg-zinc-900/70 px-1 py-2">
          <AudioMeters left={audioMeterLeft} right={audioMeterRight} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex h-full min-h-0 flex-col bg-zinc-900 ${isDragOverFiles ? 'ring-2 ring-inset ring-blue-500/50' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Timeline
          </span>
          {sequences.length > 0 && (
            <span className="text-[10px] text-zinc-600">{sequences[0].name}</span>
          )}
          <span className="rounded bg-zinc-700/50 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">
            {Math.round(fps)}fps
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              className={`rounded px-1.5 py-0.5 text-[10px] ${timelineTool === 'select' ? 'bg-blue-500/20 text-blue-200' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Selection tool (V)"
              onClick={() => setTimelineTool('select')}
            >
              Select
            </button>
            <button
              className={`rounded px-1.5 py-0.5 text-[10px] ${timelineTool === 'razor' ? 'bg-red-500/20 text-red-300' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Razor tool (C)"
              onClick={() => setTimelineTool('razor')}
            >
              Razor
            </button>
            <button
              className={`rounded px-1.5 py-0.5 text-[10px] ${rippleMode ? 'bg-amber-500/25 text-amber-300' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Toggle ripple delete mode"
              onClick={() => setRippleMode(!rippleMode)}
            >
              Ripple
            </button>
            <button
              className={`rounded px-1.5 py-0.5 text-[10px] ${linkedSelection ? 'bg-cyan-500/25 text-cyan-200' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Toggle linked selection (Alt temporarily flips)"
              onClick={() => setLinkedSelection(!linkedSelection)}
            >
              Link
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              title="Unlink selected clips"
              disabled={selectedClipIds.size === 0}
              onClick={() => void unlinkSelectedClips(Array.from(selectedClipIds))}
            >
              Unlink
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              title="Relink exactly two selected clips"
              disabled={selectedClipIds.size !== 2}
              onClick={() => void relinkSelectedClips(Array.from(selectedClipIds))}
            >
              Relink
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              onClick={async () => {
                const id = await addTrack('video');
                if (id) setTargetVideoTrackId(id);
              }}
              title="Add video track"
            >
              +V
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              onClick={() => void addTrack('audio')}
              title="Add audio track"
            >
              +A
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              onClick={() => {
                const trackId = resolveTargetVideoTrackId();
                if (!trackId) return;
                void addGeneratorClip({
                  trackId,
                  generator: { kind: 'black-video' },
                  startFrame: currentFrame,
                  durationFrames: Math.max(1, Math.round(fps * 5)),
                  insertMode: rippleMode ? 'ripple' : 'overwrite',
                });
              }}
              title="Insert black video at playhead"
            >
              +Black
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              onClick={() => {
                const trackId = resolveTargetVideoTrackId();
                if (!trackId) return;
                const value = window.prompt('Color matte hex (#RRGGBB)', '#3b82f6') ?? '';
                const color = value.trim();
                if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
                void addGeneratorClip({
                  trackId,
                  generator: { kind: 'color-matte', color },
                  startFrame: currentFrame,
                  durationFrames: Math.max(1, Math.round(fps * 5)),
                  insertMode: rippleMode ? 'ripple' : 'overwrite',
                });
              }}
              title="Insert color matte at playhead"
            >
              +Color
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              onClick={() => {
                const trackId = resolveTargetVideoTrackId();
                if (!trackId) return;
                void addGeneratorClip({
                  trackId,
                  generator: { kind: 'adjustment-layer' },
                  startFrame: currentFrame,
                  durationFrames: Math.max(1, Math.round(fps * 5)),
                  insertMode: rippleMode ? 'ripple' : 'overwrite',
                });
              }}
              title="Insert adjustment layer at playhead"
            >
              +Adj
            </button>
            <button
              className="text-xs text-zinc-400 hover:text-white"
              onClick={() => zoomAroundPlayhead(1 / 1.25)}
              title="Zoom out around playhead"
            >
              âˆ’
            </button>
            <span
              className="w-24 text-center font-mono text-[10px] text-zinc-500"
              title="Visible span"
            >
              {formatViewSpan(visibleFrames)}
            </span>
            <button
              className="text-xs text-zinc-400 hover:text-white"
              onClick={() => zoomAroundPlayhead(1.25)}
              title="Zoom in around playhead"
            >
              +
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
              title="Fit entire timeline in view (\\)"
              onClick={fitTimelineInView}
            >
              Fit All
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
              title="Previous marker ([)"
              onClick={jumpToPrevMarker}
            >
              â—€M
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
              title="Toggle marker (M)"
              onClick={toggleMarkerAtCurrent}
            >
              M+
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
              title="Next marker (])"
              onClick={jumpToNextMarker}
            >
              Mâ–¶
            </button>
            <span className="rounded bg-zinc-700/40 px-1 py-0.5 text-[9px] text-fuchsia-300">
              {markers.length}m
            </span>
          </div>
          <span className="font-mono text-xs text-zinc-400">{formatTimecode(currentFrame)}</span>
        </div>
      </div>

      {markers.length > 0 && (
        <div className="border-b border-zinc-700 bg-zinc-900/60 px-3 py-1">
          <div className="flex max-h-20 flex-wrap items-center gap-1 overflow-y-auto">
            {markers.map((m) => (
              <div
                key={`panel-${m.id}`}
                className="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5"
              >
                <button
                  className="rounded px-1 text-[9px] text-fuchsia-300 hover:bg-zinc-700"
                  title="Jump to marker"
                  onClick={() => setCurrentFrame(m.frame)}
                >
                  {formatTimecode(m.frame)}
                </button>
                <input
                  value={m.name}
                  onChange={(e) => updateMarker(m.id, { name: e.target.value })}
                  className="w-14 rounded bg-zinc-700 px-1 text-[9px] text-zinc-200"
                />
                <input
                  type="color"
                  value={m.color}
                  onChange={(e) => updateMarker(m.id, { color: e.target.value })}
                  className="h-4 w-4 rounded border border-zinc-600 bg-transparent p-0"
                  title="Marker color"
                />
                <button
                  className="rounded px-1 text-[9px] text-zinc-500 hover:bg-zinc-700 hover:text-red-300"
                  title="Remove marker"
                  onClick={() => removeMarker(m.id)}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Track headers */}
        <div
          ref={headerScrollRef}
          className="w-32 flex-shrink-0 overflow-y-auto border-r border-zinc-700"
          onScroll={(e) => {
            if (syncingScrollRef.current) return;
            const clip = containerRef.current;
            if (!clip) return;
            syncingScrollRef.current = true;
            clip.scrollTop = e.currentTarget.scrollTop;
            requestAnimationFrame(() => {
              syncingScrollRef.current = false;
            });
          }}
        >
          <div
            style={{ height: RULER_HEIGHT }}
            className="sticky top-0 z-10 border-b border-zinc-700 bg-zinc-900"
          />
          {tracks.map((track) => (
            <div
              key={track.id}
              className="flex items-center border-b border-zinc-800 px-2"
              style={{ height: TRACK_HEIGHT }}
            >
              <div className="flex-1">
                <button
                  className={`rounded px-1 text-xs font-medium ${
                    track.type === 'video'
                      ? targetVideoTrackId === track.id
                        ? 'bg-blue-500/25 text-blue-200'
                        : 'text-zinc-300 hover:text-blue-200'
                      : targetAudioTrackId === track.id
                        ? 'bg-blue-500/25 text-blue-200'
                        : 'text-zinc-300 hover:text-blue-200'
                  }`}
                  onClick={() => {
                    if (track.type === 'video') setTargetVideoTrackId(track.id);
                    else setTargetAudioTrackId(track.id);
                  }}
                  title="Set source insert target track"
                >
                  {track.name}
                </button>
                <div className="mt-0.5 flex gap-1">
                  <button
                    className={`rounded px-1 text-[10px] ${track.muted ? 'bg-red-500/20 text-red-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    title="Mute"
                    onClick={() => updateTrack(track.id, { muted: !track.muted })}
                  >
                    M
                  </button>
                  <button
                    className={`rounded px-1 text-[10px] ${track.solo ? 'bg-yellow-500/20 text-yellow-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    title="Solo"
                    onClick={() => updateTrack(track.id, { solo: !track.solo })}
                  >
                    S
                  </button>
                  <button
                    className={`rounded px-1 text-[10px] ${track.locked ? 'bg-orange-500/20 text-orange-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                    title="Lock"
                    onClick={() => updateTrack(track.id, { locked: !track.locked })}
                  >
                    ðŸ”’
                  </button>
                  <button
                    className={`rounded px-1 text-[10px] ${track.syncLocked !== false ? 'bg-cyan-500/20 text-cyan-300' : 'text-zinc-500 hover:text-zinc-300'}`}
                    title="Sync lock (affects ripple/extract)"
                    onClick={() =>
                      updateTrack(track.id, { syncLocked: track.syncLocked === false })
                    }
                  >
                    SY
                  </button>
                  {track.type === 'audio' && (
                    <button
                      className="rounded px-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                      title="Audio channel mode"
                      onClick={() =>
                        setChannelConfigTrackId((id) => (id === track.id ? null : track.id))
                      }
                    >
                      CH
                    </button>
                  )}
                  {track.type === 'audio' && (
                    <span
                      className="rounded bg-zinc-700/50 px-1 text-[9px] font-mono text-zinc-300"
                      title={`Audio routing: ${track.channelMode === 'mono' ? `Mono ${track.channelMap ?? 'L+R'}` : 'Stereo'}`}
                    >
                      {track.channelMode === 'mono' ? `MO-${track.channelMap ?? 'LR'}` : 'ST'}
                    </span>
                  )}
                </div>
                {track.type === 'audio' && channelConfigTrackId === track.id && (
                  <div className="mt-1 rounded border border-zinc-700 bg-zinc-900 p-1 text-[10px]">
                    <div className="mb-1 flex items-center gap-1">
                      <span className="text-zinc-500">Mode</span>
                      <select
                        value={track.channelMode ?? 'stereo'}
                        onChange={(e) =>
                          void updateTrack(track.id, {
                            channelMode: e.target.value as 'stereo' | 'mono',
                          })
                        }
                        className="rounded bg-zinc-800 px-1 text-zinc-200"
                      >
                        <option value="stereo">Stereo</option>
                        <option value="mono">Mono</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-zinc-500">Map (mono)</span>
                      <select
                        value={track.channelMap ?? 'L+R'}
                        disabled={(track.channelMode ?? 'stereo') !== 'mono'}
                        onChange={(e) =>
                          void updateTrack(track.id, {
                            channelMap: e.target.value as 'L+R' | 'L' | 'R',
                          })
                        }
                        className="rounded bg-zinc-800 px-1 text-zinc-200 disabled:opacity-40"
                      >
                        <option value="L+R">L+R</option>
                        <option value="L">Left</option>
                        <option value="R">Right</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          {tracks.length === 0 && (
            <div
              className="flex items-center px-2 text-xs text-zinc-600"
              style={{ height: TRACK_HEIGHT }}
            >
              No tracks
            </div>
          )}
          <div className="flex items-center gap-1 border-t border-zinc-700 px-2 py-1">
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              onClick={async () => {
                const id = await addTrack('video');
                if (id) setTargetVideoTrackId(id);
              }}
              title="Add video track"
            >
              +V
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              onClick={() => void addTrack('audio')}
              title="Add audio track"
            >
              +A
            </button>
          </div>
        </div>

        {/* Clip area */}
        <div
          ref={containerRef}
          className={`relative flex-1 overflow-auto ${timelineTool === 'razor' ? 'cursor-cell' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOverTimeline}
          onDragLeave={handleDragLeaveTimeline}
          onScroll={(e) => {
            setScrollLeft(e.currentTarget.scrollLeft);
            if (syncingScrollRef.current) return;
            const header = headerScrollRef.current;
            if (!header) return;
            syncingScrollRef.current = true;
            header.scrollTop = e.currentTarget.scrollTop;
            requestAnimationFrame(() => {
              syncingScrollRef.current = false;
            });
          }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest('[data-clip="true"]')) return;
            if ((e.target as HTMLElement).closest('[data-ruler="true"]')) return;
            if ((e.target as HTMLElement).closest('[data-no-marquee="true"]')) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left + e.currentTarget.scrollLeft;
            const y = e.clientY - rect.top + e.currentTarget.scrollTop;
            marqueeRef.current = { startX: x, startY: y, currentX: x, currentY: y, moved: false };
            setMarqueeBox(null);
          }}
          style={{ minWidth: 0 }}
        >
          <div style={{ width: totalWidth, position: 'relative' }}>
            {/* Ruler â€” click to seek */}
            <div
              data-ruler="true"
              className="sticky top-0 z-10 border-b border-zinc-700 bg-zinc-900/90 cursor-pointer select-none"
              style={{ height: RULER_HEIGHT }}
              onClick={handleRulerClick}
              onMouseDown={(e) => {
                // Start scrub on ruler mousedown too
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left + scrollLeft;
                const frame = Math.max(0, Math.round(x / pxPerFrame));
                setCurrentFrame(frame);
                isScrubbingRef.current = true;
                usePlaybackStore.getState().pause();
              }}
            >
              <TimeRuler pxPerFrame={pxPerFrame} fps={fps} scrollLeft={scrollLeft} />
              {inPoint !== null && (
                <div
                  className="absolute top-0 h-full w-0.5 bg-blue-500/70"
                  style={{ left: inPoint * pxPerFrame }}
                />
              )}
              {outPoint !== null && (
                <div
                  className="absolute top-0 h-full w-0.5 bg-blue-500/70"
                  style={{ left: outPoint * pxPerFrame }}
                />
              )}
              {markers.map((m) => (
                <div
                  key={`mk-${m.id}`}
                  className="absolute top-0 h-full w-0.5"
                  style={{ left: m.frame * pxPerFrame, backgroundColor: m.color }}
                  title={`${m.name} ${formatTimecode(m.frame)}`}
                />
              ))}
            </div>

            {/* In/Out range highlight */}
            {inPoint !== null && outPoint !== null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 bg-blue-500/5"
                style={{ left: inPoint * pxPerFrame, width: (outPoint - inPoint) * pxPerFrame }}
              />
            )}

            {/* Track rows */}
            {tracks.map((track) => (
              <div
                key={track.id}
                className={`relative border-b border-zinc-800 ${track.type === 'video' ? 'bg-zinc-900/30' : 'bg-zinc-900/50'} ${track.locked ? 'opacity-50' : ''}`}
                style={{ height: TRACK_HEIGHT }}
                onClick={(e) => handleTrackClick(track, e)}
              >
                {track.clips.map((clip) => {
                  const isSelected = selectedClipIds.has(clip.id);
                  const isDragging = dragRef.current?.clipId === clip.id && dragDelta !== 0;
                  const style = getClipVisualStyle(clip);
                  const clipSpeed = clip.speed ?? 1;
                  const showSpeedBadge = Math.abs(clipSpeed - 1) > 0.001;
                  const speedBadge =
                    clipSpeed < 0
                      ? `â†º ${Math.round(Math.abs(clipSpeed) * 100)}%`
                      : `${Math.round(clipSpeed * 100)}%`;

                  return (
                    <div
                      key={clip.id}
                      data-clip="true"
                      className={`absolute top-1 bottom-1 rounded border select-none ${
                        isDragging ? 'opacity-80 z-10' : ''
                      } ${
                        isSelected
                          ? 'border-white ring-1 ring-white/30'
                          : clip.type === 'video' || clip.type === 'image'
                            ? 'border-blue-500/40 hover:border-blue-400/60'
                            : 'border-green-500/40 hover:border-green-400/60'
                      } ${
                        clip.type === 'video' || clip.type === 'image'
                          ? 'bg-blue-500/20'
                          : 'bg-green-500/20'
                      } ${timelineTool === 'razor' ? 'cursor-cell' : 'cursor-move'}`}
                      style={{ left: style.left, width: style.width }}
                      onMouseDown={(e) => handleClipMouseDown(clip, track.id, 'move', e)}
                    >
                      <div className="pointer-events-none relative z-10 flex items-center gap-1 px-1 py-0.5 text-[10px] text-zinc-300">
                        <span className="truncate">{clip.name}</span>
                        {showSpeedBadge && (
                          <span className="shrink-0 rounded bg-black/40 px-1 text-[9px] text-zinc-200">
                            {speedBadge}
                          </span>
                        )}
                        {clip.generator && (
                          <span className="shrink-0 rounded bg-black/40 px-1 text-[9px] text-amber-200">
                            {clip.generator.kind === 'adjustment-layer'
                              ? 'ADJ'
                              : clip.generator.kind === 'color-matte'
                                ? 'MATTE'
                                : 'BLACK'}
                          </span>
                        )}
                      </div>
                      {(clip.keyframes?.length ?? 0) > 0 && (
                        <div className="pointer-events-none absolute left-1 right-1 top-4 h-2">
                          {clip.keyframes!.map((kf) => {
                            const pct = Math.max(
                              0,
                              Math.min(1, kf.frame / Math.max(1, clip.durationFrames)),
                            );
                            return (
                              <div
                                key={kf.id}
                                className="absolute h-1.5 w-1.5 rotate-45 bg-blue-300/80"
                                style={{ left: `${pct * 100}%`, top: 0 }}
                              />
                            );
                          })}
                        </div>
                      )}
                      {/* Waveform for audio clips */}
                      {track.type === 'audio' && clip.mediaAssetId && style.width > 10 && (
                        <WaveformCanvas
                          mediaAssetId={clip.mediaAssetId}
                          width={style.width}
                          height={TRACK_HEIGHT - 8}
                          gainScale={
                            clip.audioGainDb != null
                              ? clip.audioGainDb <= -59.5
                                ? 0
                                : Math.pow(10, clip.audioGainDb / 20)
                              : (clip.gain ?? clip.audioVolume ?? 1)
                          }
                        />
                      )}
                      {clip.transitionIn && (
                        <div
                          className="pointer-events-none absolute left-0 top-0 border-r border-r-cyan-300/80 border-t border-t-transparent border-b border-b-transparent"
                          style={{
                            width: 0,
                            height: 0,
                            borderTopWidth: `${(TRACK_HEIGHT - 8) / 2}px`,
                            borderBottomWidth: `${(TRACK_HEIGHT - 8) / 2}px`,
                            borderRightWidth: `${Math.max(6, Math.min(style.width * 0.25, clip.transitionIn.durationFrames * pxPerFrame))}px`,
                          }}
                        />
                      )}
                      {clip.transitionOut && (
                        <div
                          className="pointer-events-none absolute right-0 top-0 border-l border-l-cyan-300/80 border-t border-t-transparent border-b border-b-transparent"
                          style={{
                            width: 0,
                            height: 0,
                            borderTopWidth: `${(TRACK_HEIGHT - 8) / 2}px`,
                            borderBottomWidth: `${(TRACK_HEIGHT - 8) / 2}px`,
                            borderLeftWidth: `${Math.max(6, Math.min(style.width * 0.25, clip.transitionOut.durationFrames * pxPerFrame))}px`,
                          }}
                        />
                      )}
                      {/* Left trim handle */}
                      <div
                        className={`absolute left-0 top-0 bottom-0 w-1.5 hover:bg-white/30 active:bg-white/40 ${timelineTool === 'razor' ? 'pointer-events-none opacity-20' : 'cursor-col-resize'}`}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          handleClipMouseDown(clip, track.id, 'trim-left', e);
                        }}
                      />
                      {/* Right trim handle */}
                      <div
                        className={`absolute right-0 top-0 bottom-0 w-1.5 hover:bg-white/30 active:bg-white/40 ${timelineTool === 'razor' ? 'pointer-events-none opacity-20' : 'cursor-col-resize'}`}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          handleClipMouseDown(clip, track.id, 'trim-right', e);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Snap line â€” yellow vertical line shown during drag */}
            {snapLineFrame !== null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 bg-yellow-400"
                style={{ left: snapLineFrame * pxPerFrame }}
              />
            )}

            {/* Ripple indicator badge */}
            {isRipple && dragRef.current && (
              <div
                className="pointer-events-none absolute z-30 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold text-black"
                style={{ top: 4, left: dragRef.current.origStartFrame * pxPerFrame + 50 }}
              >
                RIPPLE
              </div>
            )}

            {marqueeBox && (
              <div
                className="pointer-events-none absolute z-40 border border-blue-400/70 bg-blue-500/15"
                style={{
                  left: marqueeBox.left,
                  top: marqueeBox.top,
                  width: marqueeBox.width,
                  height: marqueeBox.height,
                }}
              />
            )}

            {/* Playhead â€” draggable */}
            <div
              data-no-marquee="true"
              className="absolute top-0 bottom-0 z-20"
              style={{ left: currentFrame * pxPerFrame, transform: 'translateX(-6px)', width: 13 }}
            >
              {/* Vertical line */}
              <div className="pointer-events-none absolute left-[6px] top-0 bottom-0 w-0.5 bg-red-500" />
              {/* Draggable head triangle */}
              <div
                className="absolute top-0 left-0 cursor-col-resize"
                style={{ width: 13, height: RULER_HEIGHT, pointerEvents: 'auto' }}
                onMouseDown={handlePlayheadMouseDown}
              >
                <div
                  className="absolute left-1/2 -translate-x-1/2"
                  style={{
                    width: 0,
                    height: 0,
                    borderLeft: '6px solid transparent',
                    borderRight: '6px solid transparent',
                    borderTop: '8px solid #ef4444',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        <aside className="w-20 flex-shrink-0 border-l border-zinc-700 bg-zinc-900/85 px-1 py-2">
          <AudioMeters left={audioMeterLeft} right={audioMeterRight} />
        </aside>
      </div>

      <ConfirmDialog
        open={!!firstClipPrompt}
        title="Match project settings to first clip?"
        message={firstClipPrompt?.message ?? ''}
        warning="This affects sequence resolution and frame rate for this project."
        confirmLabel="Match Project to Clip"
        cancelLabel="Keep Project Settings"
        onCancel={() => {
          if (!firstClipPrompt) return;
          const p = firstClipPrompt;
          setFirstClipPrompt(null);
          void addClipToTrack({
            trackId: p.trackId,
            asset: p.asset,
            startFrame: p.startFrame,
            sourceInFrame: p.sourceInFrame,
            sourceOutFrame: p.sourceOutFrame,
            insertMode: p.insertMode,
          });
        }}
        onConfirm={async () => {
          if (!firstClipPrompt) return;
          const p = firstClipPrompt;
          setFirstClipPrompt(null);

          const settings: {
            defaultFrameRate?: { num: number; den: number };
            defaultResolution?: { width: number; height: number };
            audioSampleRate?: number;
            aspectRatio?: string;
            audioChannels?: number;
          } = {};

          if (p.asset.resolution) {
            settings.defaultResolution = {
              width: p.asset.resolution.width,
              height: p.asset.resolution.height,
            };
            const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
            const d = g(settings.defaultResolution.width, settings.defaultResolution.height);
            settings.aspectRatio = `${settings.defaultResolution.width / d}:${settings.defaultResolution.height / d}`;
          }
          if (p.asset.frameRate) {
            settings.defaultFrameRate = p.asset.frameRate;
          }
          if (p.asset.audioSampleRate) {
            settings.audioSampleRate = p.asset.audioSampleRate;
          }

          await updateProjectSettings(settings);
          await addClipToTrack({
            trackId: p.trackId,
            asset: p.asset,
            startFrame: p.startFrame,
            sourceInFrame: p.sourceInFrame,
            sourceOutFrame: p.sourceOutFrame,
            insertMode: p.insertMode,
          });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Waveform display for audio clips
// ---------------------------------------------------------------------------

function AudioMeters({ left, right }: { left: number; right: number }) {
  const ticks = ['0', '-6', '-12', '-18', '-24', '-36', '-48'];
  const [holdL, setHoldL] = useState(0);
  const [holdR, setHoldR] = useState(0);

  useEffect(() => {
    setHoldL((p) => Math.max(p - 0.02, left));
    setHoldR((p) => Math.max(p - 0.02, right));
  }, [left, right]);

  return (
    <div className="relative flex h-full items-end justify-center gap-1 pl-1 pr-5">
      {([left, right] as const).map((v, idx) => (
        <div key={idx} className="relative flex h-full w-5 items-end rounded bg-zinc-800/90">
          <div
            className="w-full rounded-b bg-gradient-to-t from-emerald-500 via-yellow-400 to-red-500"
            style={{ height: `${Math.round(v * 100)}%` }}
          />
          <div
            className="absolute left-0 right-0 h-[2px] bg-yellow-300"
            style={{ bottom: `${Math.round((idx === 0 ? holdL : holdR) * 100)}%` }}
          />
          <div className="pointer-events-none absolute inset-0">
            {ticks.map((t, i) => (
              <div
                key={`${idx}-${t}`}
                className="absolute left-0 right-0 border-t border-zinc-700/70"
                style={{ top: `${(i / (ticks.length - 1)) * 100}%` }}
              />
            ))}
          </div>
          <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[9px] text-zinc-500">
            {idx === 0 ? 'L' : 'R'}
          </span>
        </div>
      ))}
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 flex flex-col justify-between text-[9px] text-zinc-500">
        {ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  );
}

/** Global cache of waveform peaks by mediaAssetId. */
const waveformCache = new Map<string, number[]>();

function WaveformCanvas({
  mediaAssetId,
  width,
  height,
  gainScale = 1,
}: {
  mediaAssetId: string;
  width: number;
  height: number;
  gainScale?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  // Fetch waveform data (cached)
  useEffect(() => {
    if (!mediaAssetId) return;
    const cached = waveformCache.get(mediaAssetId);
    if (cached) {
      setPeaks(cached);
      return;
    }

    let cancelled = false;
    const sampledWidth = Math.max(200, Math.min(4000, Math.round(width)));
    api.media
      .waveform(mediaAssetId, sampledWidth)
      .then((data) => {
        if (cancelled) return;
        waveformCache.set(mediaAssetId, data.peaks);
        setPeaks(data.peaks);
      })
      .catch(() => {
        // Waveform generation failed â€” silently ignore
      });

    return () => {
      cancelled = true;
    };
  }, [mediaAssetId, width]);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;

    const dpr = 1;
    const renderWidth = Math.max(1, Math.min(4000, Math.round(width)));
    canvas.width = renderWidth * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(74, 222, 128, 0.5)'; // green-400/50

    const barWidth = canvas.width / Math.max(1, peaks.length);
    const midY = canvas.height / 2;

    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.min(1, peaks[i] * Math.max(0, gainScale)) * midY;
      const x = i * barWidth;
      ctx.fillRect(x, midY - amp, Math.max(1, barWidth - 0.5), amp * 2);
    }
  }, [peaks, width, height, gainScale]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      style={{ width, height }}
    />
  );
}

// ---------------------------------------------------------------------------
// Time ruler sub-component â€” adaptive tick marks
// ---------------------------------------------------------------------------

function TimeRuler({
  pxPerFrame,
  fps,
  scrollLeft,
}: {
  pxPerFrame: number;
  fps: number;
  scrollLeft: number;
}) {
  const roundedFps = Math.max(1, Math.round(fps));
  const pxPerSecond = pxPerFrame * roundedFps;

  let majorFrames = roundedFps;
  let minorDivisions = 5;
  if (pxPerFrame >= 120) {
    majorFrames = 1;
    minorDivisions = 1;
  } else if (pxPerFrame >= 50) {
    majorFrames = 5;
    minorDivisions = 1;
  } else if (pxPerFrame >= 20) {
    majorFrames = 10;
    minorDivisions = 2;
  } else if (pxPerSecond >= 240) {
    majorFrames = roundedFps;
    minorDivisions = 6;
  } else if (pxPerSecond >= 80) {
    majorFrames = roundedFps * 5;
    minorDivisions = 5;
  } else if (pxPerSecond >= 24) {
    majorFrames = roundedFps * 10;
    minorDivisions = 5;
  } else {
    majorFrames = roundedFps * 30;
    minorDivisions = 6;
  }

  const viewWidth = 3500;
  const startFrame = Math.max(0, Math.floor(scrollLeft / pxPerFrame) - majorFrames);
  const endFrame = Math.ceil((scrollLeft + viewWidth) / pxPerFrame) + majorFrames;

  const firstMajor = Math.floor(startFrame / majorFrames) * majorFrames;
  const minorFrames = Math.max(1, Math.round(majorFrames / minorDivisions));

  const ticks: React.ReactElement[] = [];

  const maxTicks = 800;
  let count = 0;
  for (let frame = firstMajor; frame <= endFrame; frame += minorFrames) {
    if (frame < 0) continue;
    const x = frame * pxPerFrame;
    const isMajor = frame % majorFrames === 0;
    if (++count > maxTicks) break;

    if (isMajor) {
      const totalSec = Math.floor(frame / roundedFps);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      const ff = frame % roundedFps;
      ticks.push(
        <div
          key={`M${frame}`}
          className="absolute top-0 h-full border-l border-zinc-600/60"
          style={{ left: x }}
        >
          <span
            className="ml-1 text-[9px] leading-none text-zinc-500"
            style={{ position: 'relative', top: 2 }}
          >
            {majorFrames < roundedFps ? `${m}:${pad(s)}:${pad(ff)}` : `${m}:${pad(s)}`}
          </span>
        </div>,
      );
    } else {
      ticks.push(
        <div
          key={`m${frame}`}
          className="absolute bottom-0 border-l border-zinc-700/40"
          style={{ left: x, height: 6 }}
        />,
      );
    }
  }

  return <>{ticks}</>;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

