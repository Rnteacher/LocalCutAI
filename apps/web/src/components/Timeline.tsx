/**
 * Timeline panel - the core editing surface.
 *
 * Shows track headers, clip blocks, playhead, and time ruler.
 * Supports drag-and-drop from project browser, clip selection,
 * clip move (drag), clip trimming (edge drag), and playhead scrub.
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useProjectStore, computeTransitionSideLimit } from '../stores/projectStore.js';
import { usePlaybackStore } from '../stores/playbackStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import type { ApiMediaAsset } from '../lib/api.js';
import type { TimelineMarker } from '../stores/playbackStore.js';
import type { TimelineKeyframeData } from '../stores/projectStore.js';
import { api } from '../lib/api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  AddKeyGlyph,
  IconActionButton,
  KeyframeMiniGraph,
  KEYFRAME_PROPERTIES,
  NextGlyph,
  PrevGlyph,
  TrashGlyph,
} from './Inspector.js';
import type { KeyframeProperty } from './Inspector.js';

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

interface TimelineClipKeyframe {
  id: string;
  frame: number;
  property: TimelineKeyframeData['property'];
  value: number;
  easing: TimelineKeyframeData['easing'];
  bezierHandles?: TimelineKeyframeData['bezierHandles'];
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
  opacity?: number;
  positionX?: number;
  positionY?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  speed?: number;
  gain?: number;
  pan?: number;
  audioPan?: number;
  audioGainDb?: number;
  audioVolume?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  vignette?: number;
  keyframes?: TimelineClipKeyframe[];
  blendMode?: string;
  transitionIn?: {
    id: string;
    type: string;
    durationFrames: number;
    audioCrossfade?: boolean;
  } | null;
  transitionOut?: {
    id: string;
    type: string;
    durationFrames: number;
    audioCrossfade?: boolean;
  } | null;
  masks?: Array<{
    opacity?: number;
    feather?: number;
    expansion?: number;
  }>;
  generator?: { kind: 'black-video' | 'color-matte' | 'adjustment-layer'; color?: string } | null;
}

// Drag/Trim interaction state
interface DragState {
  mode: 'move' | 'trim-left' | 'trim-right' | 'transition-in' | 'transition-out';
  clipId: string;
  trackId: string;
  origStartFrame: number;
  origDurationFrames: number;
  sourceInFrame?: number;
  sourceOutFrame?: number;
  mediaAssetId?: string | null;
  copyOnDrag?: boolean;
  transitionId?: string;
  transitionType?: 'cross-dissolve' | 'fade-black';
  transitionAudioCrossfade?: boolean;
  origTransitionDurationFrames?: number;
  startX: number; // mouse X at drag start
}

interface KeyframeDragState {
  clipId: string;
  keyframeId: string;
  startX: number;
  origFrame: number;
  clipDurationFrames: number;
}

type TransitionLimitInputTrack = Parameters<typeof computeTransitionSideLimit>[0]['track'];
type TransitionLimitInputClip = Parameters<typeof computeTransitionSideLimit>[0]['clip'];

function normalizeTransitionType(type: string | undefined): 'cross-dissolve' | 'fade-black' {
  return type === 'fade-black' ? 'fade-black' : 'cross-dissolve';
}

function keyframeColor(property: string): string {
  if (property === 'speed') return '#14b8a6';
  if (property === 'volume' || property === 'pan') return '#f43f5e';
  if (
    property === 'brightness' ||
    property === 'contrast' ||
    property === 'saturation' ||
    property === 'hue' ||
    property === 'vignette'
  ) {
    return '#f59e0b';
  }
  if (property.startsWith('transform.position')) return '#f97316';
  if (property.startsWith('transform.scale')) return '#22c55e';
  if (property === 'transform.rotation') return '#eab308';
  if (property.startsWith('transform.anchor')) return '#60a5fa';
  if (property.startsWith('mask.')) return '#22d3ee';
  if (property === 'opacity') return '#a78bfa';
  return '#93c5fd';
}

function CurveGlyph({
  path,
  fill = false,
}: {
  path: React.ReactNode;
  fill?: boolean;
}) {
  return (
    <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 ${fill ? 'fill-current' : 'fill-none stroke-current'}`}>
      {path}
    </svg>
  );
}

function LinearGlyph() {
  return (
    <CurveGlyph
      path={<path d="M3 11.5 13 4.5" strokeWidth="1.6" strokeLinecap="round" />}
    />
  );
}

function EaseInGlyph() {
  return (
    <CurveGlyph
      path={<path d="M3 11.5c2.2 0 2.8-5.6 10-7" strokeWidth="1.6" strokeLinecap="round" />}
    />
  );
}

function EaseOutGlyph() {
  return (
    <CurveGlyph
      path={<path d="M3 11.5c7.2-1.4 7.8-7 10-7" strokeWidth="1.6" strokeLinecap="round" />}
    />
  );
}

function EaseInOutGlyph() {
  return (
    <CurveGlyph
      path={<path d="M3 11.5c2.6 0 2.4-7 5-7s2.4 7 5 7" strokeWidth="1.6" strokeLinecap="round" />}
    />
  );
}

function BezierGlyph() {
  return (
    <CurveGlyph
      path={
        <>
          <path d="M3 11.5c2.5 0 2.5-7 5-7s2.5 7 5 7" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="3" cy="11.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="8" cy="4.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="13" cy="11.5" r="1" fill="currentColor" stroke="none" />
        </>
      }
    />
  );
}

function CopyGlyph() {
  return (
    <CurveGlyph
      fill
      path={
        <>
          <rect x="5" y="3" width="7" height="9" rx="1.2" />
          <path d="M4 5H3.5A1.5 1.5 0 0 0 2 6.5v6A1.5 1.5 0 0 0 3.5 14H9" strokeWidth="1.2" />
        </>
      }
    />
  );
}

function PasteGlyph() {
  return (
    <CurveGlyph
      fill
      path={
        <>
          <path d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v7A1.5 1.5 0 0 1 11 13.5H5A1.5 1.5 0 0 1 3.5 12V5A1.5 1.5 0 0 1 5 3.5Z" />
          <path d="M6 2.5h4v2H6z" />
        </>
      }
    />
  );
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
  const setClipTransition = useProjectStore((s) => s.setClipTransition);
  const splitClipAtPlayhead = useProjectStore((s) => s.splitClipAtPlayhead);
  const upsertClipKeyframe = useProjectStore((s) => s.upsertClipKeyframe);
  const removeClipKeyframe = useProjectStore((s) => s.removeClipKeyframe);
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
  const linkedScale = useSelectionStore((s) => s.linkedScale);
  const autoKeyframeEnabled = useSelectionStore((s) => s.autoKeyframeEnabled);
  const setTimelineTool = useSelectionStore((s) => s.setTimelineTool);
  const setRippleMode = useSelectionStore((s) => s.setRippleMode);
  const setLinkedSelection = useSelectionStore((s) => s.setLinkedSelection);
  const setAutoKeyframeEnabled = useSelectionStore((s) => s.setAutoKeyframeEnabled);
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
  const [timelineViewMode, setTimelineViewMode] = useState<'timeline' | 'graph'>('timeline');
  const [graphProperty, setGraphProperty] = useState<KeyframeProperty>('transform.positionX');
  const [graphSnapStep, setGraphSnapStep] = useState(1);
  const [selectedGraphKeyframeId, setSelectedGraphKeyframeId] = useState<string | null>(null);
  const [selectedGraphKeyframeIds, setSelectedGraphKeyframeIds] = useState<string[]>([]);
  const [graphKeyframeClipboard, setGraphKeyframeClipboard] = useState<{
    property: KeyframeProperty;
    items: Array<Pick<TimelineKeyframeData, 'value' | 'easing' | 'bezierHandles'> & { offsetFrame: number }>;
  } | null>(null);
  const [graphMarkerDraftFrames, setGraphMarkerDraftFrames] = useState<Record<string, number>>({});
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
  const keyframeDragRef = useRef<KeyframeDragState | null>(null);
  const [keyframeDragFrame, setKeyframeDragFrame] = useState<number | null>(null);
  const graphEditorRef = useRef<HTMLDivElement | null>(null);
  const graphScrubRef = useRef<HTMLDivElement | null>(null);
  const graphOverviewRef = useRef<HTMLDivElement | null>(null);
  const graphMarkerDragRef = useRef<{
    clipId: string;
    property: KeyframeProperty;
    container: HTMLDivElement;
    anchorClientX: number;
    selectedIds: string[];
    startFrames: Record<string, number>;
    minDelta: number;
    maxDelta: number;
  } | null>(null);
  const pendingGraphSelectionRef = useRef<{ ids: string[]; primaryId: string | null } | null>(null);

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

  const selectedGraphClip = useMemo((): TimelineClip | null => {
    if (selectedClipIds.size !== 1) return null;
    const selectedId = Array.from(selectedClipIds)[0];
    for (const track of tracks) {
      const clip = track.clips.find((item) => item.id === selectedId);
      if (clip) return clip;
    }
    return null;
  }, [selectedClipIds, tracks]);

  const timelineGraphEndFrame = useMemo(() => {
    let maxFrame = 0;
    for (const track of tracks) {
      for (const clip of track.clips) {
        maxFrame = Math.max(maxFrame, clip.startFrame + clip.durationFrames);
      }
    }
    return Math.max(1, maxFrame, currentFrame + 1);
  }, [tracks, currentFrame]);

  const graphKeyframesByProperty = useMemo(() => {
    const map = new Map<KeyframeProperty, TimelineClipKeyframe[]>();
    for (const item of KEYFRAME_PROPERTIES) {
      map.set(item.value, []);
    }
    const source = [...(selectedGraphClip?.keyframes ?? [])].sort((a, b) => a.frame - b.frame);
    for (const keyframe of source) {
      const bucket = map.get(keyframe.property as KeyframeProperty);
      if (bucket) {
        bucket.push(keyframe);
      }
    }
    return map;
  }, [selectedGraphClip?.keyframes]);

  const graphPropertiesWithKeyframes = useMemo(
    () =>
      KEYFRAME_PROPERTIES.filter(
        (item) => (graphKeyframesByProperty.get(item.value)?.length ?? 0) > 0,
      ),
    [graphKeyframesByProperty],
  );

  useEffect(() => {
    if (!selectedGraphClip) return;
    const hasGraphProperty = (graphKeyframesByProperty.get(graphProperty)?.length ?? 0) > 0;
    if (hasGraphProperty || graphPropertiesWithKeyframes.length === 0) return;
    setGraphProperty(graphPropertiesWithKeyframes[0].value);
  }, [selectedGraphClip, graphProperty, graphKeyframesByProperty, graphPropertiesWithKeyframes]);

  const graphPropertyKeyframes = graphKeyframesByProperty.get(graphProperty) ?? [];
  const graphClipEndFrame = useMemo(
    () => (selectedGraphClip ? selectedGraphClip.startFrame + selectedGraphClip.durationFrames : 0),
    [selectedGraphClip],
  );

  const graphPropertyTimelineKeyframes = useMemo(() => {
    if (!selectedGraphClip) return [];
    return graphPropertyKeyframes.map((kf) => ({
      ...kf,
      frame: selectedGraphClip.startFrame + kf.frame,
    }));
  }, [graphPropertyKeyframes, selectedGraphClip]);

  useEffect(() => {
    if (graphPropertyTimelineKeyframes.length === 0) {
      if (selectedGraphKeyframeId !== null) {
        setSelectedGraphKeyframeId(null);
      }
      if (selectedGraphKeyframeIds.length > 0) {
        setSelectedGraphKeyframeIds([]);
      }
      if (Object.keys(graphMarkerDraftFrames).length > 0) {
        setGraphMarkerDraftFrames({});
      }
      return;
    }
    const validIds = new Set(graphPropertyTimelineKeyframes.map((keyframe) => keyframe.id));
    const filteredSelection = selectedGraphKeyframeIds.filter((id) => validIds.has(id));
    if (filteredSelection.length !== selectedGraphKeyframeIds.length) {
      setSelectedGraphKeyframeIds(filteredSelection);
    }
    if (selectedGraphKeyframeId && validIds.has(selectedGraphKeyframeId)) {
      if (filteredSelection.length === 0) {
        setSelectedGraphKeyframeIds([selectedGraphKeyframeId]);
      }
      return;
    }

    const atPlayhead = graphPropertyTimelineKeyframes.find((keyframe) => keyframe.frame === currentFrame);
    const nextId = atPlayhead?.id ?? graphPropertyTimelineKeyframes[0]!.id;
    setSelectedGraphKeyframeId(nextId);
    setSelectedGraphKeyframeIds([nextId]);
  }, [
    graphPropertyTimelineKeyframes,
    selectedGraphKeyframeId,
    selectedGraphKeyframeIds,
    graphMarkerDraftFrames,
    currentFrame,
  ]);

  useEffect(() => {
    const pending = pendingGraphSelectionRef.current;
    if (!pending || graphPropertyTimelineKeyframes.length === 0) return;
    const validIds = new Set(graphPropertyTimelineKeyframes.map((keyframe) => keyframe.id));
    const nextIds = pending.ids.filter((id) => validIds.has(id));
    if (nextIds.length !== pending.ids.length) return;
    setSelectedGraphKeyframeIds(nextIds);
    setSelectedGraphKeyframeId(
      pending.primaryId && nextIds.includes(pending.primaryId)
        ? pending.primaryId
        : nextIds[nextIds.length - 1] ?? null,
    );
    pendingGraphSelectionRef.current = null;
  }, [graphPropertyTimelineKeyframes]);

  const getGraphPropertyKeyframes = useCallback(
    (property: KeyframeProperty): TimelineClipKeyframe[] =>
      graphKeyframesByProperty.get(property) ?? [],
    [graphKeyframesByProperty],
  );

  const effectiveGraphPropertyTimelineKeyframes = useMemo(
    () =>
      [...graphPropertyTimelineKeyframes]
        .map((keyframe) => ({
          ...keyframe,
          frame: graphMarkerDraftFrames[keyframe.id] ?? keyframe.frame,
        }))
        .sort((a, b) => a.frame - b.frame),
    [graphPropertyTimelineKeyframes, graphMarkerDraftFrames],
  );

  const selectedGraphKeyframes = useMemo(
    () =>
      effectiveGraphPropertyTimelineKeyframes.filter((keyframe) => selectedGraphKeyframeIds.includes(keyframe.id)),
    [effectiveGraphPropertyTimelineKeyframes, selectedGraphKeyframeIds],
  );

  const toClipLocalFrame = useCallback((clip: TimelineClip, timelineFrame: number): number => {
    return Math.max(0, Math.min(clip.durationFrames, Math.round(timelineFrame - clip.startFrame)));
  }, []);

  const getLinkedScaleGraphProperty = useCallback(
    (property: KeyframeProperty): KeyframeProperty | null => {
      if (!linkedScale) return null;
      if (property === 'transform.scaleX') return 'transform.scaleY';
      if (property === 'transform.scaleY') return 'transform.scaleX';
      return null;
    },
    [linkedScale],
  );

  const upsertGraphKeyframeWithLinkedScale = useCallback(
    (
      property: KeyframeProperty,
      keyframe: TimelineKeyframeData,
      options?: { sourceFrame?: number },
    ) => {
      if (!selectedGraphClip) return;
      void upsertClipKeyframe(selectedGraphClip.id, keyframe);
      const linkedProperty = getLinkedScaleGraphProperty(property);
      if (!linkedProperty) return;
      const linkedKeyframes = getGraphPropertyKeyframes(linkedProperty);
      const sourceFrame = options?.sourceFrame ?? keyframe.frame;
      const linkedExisting =
        linkedKeyframes.find((item) => item.frame === sourceFrame) ??
        linkedKeyframes.find((item) => item.frame === keyframe.frame);
      void upsertClipKeyframe(selectedGraphClip.id, {
        id: linkedExisting?.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12),
        property: linkedProperty,
        frame: keyframe.frame,
        value: keyframe.value,
        easing: keyframe.easing,
        bezierHandles: keyframe.bezierHandles,
      });
    },
    [selectedGraphClip, upsertClipKeyframe, getGraphPropertyKeyframes, getLinkedScaleGraphProperty],
  );

  const resolveGraphPasteLocalFrames = useCallback(
    (
      items: Array<
        Pick<TimelineKeyframeData, 'value' | 'easing' | 'bezierHandles'> & { offsetFrame: number }
      >,
      property: KeyframeProperty,
    ): number[] => {
      if (!selectedGraphClip || items.length === 0) return [];
      const baseFrames = items.map((item) =>
        toClipLocalFrame(selectedGraphClip, currentFrame + item.offsetFrame),
      );
      const snap = Math.max(1, graphSnapStep);
      const existingFrames = new Set(getGraphPropertyKeyframes(property).map((item) => item.frame));
      const minBase = Math.min(...baseFrames);
      const maxBase = Math.max(...baseFrames);
      const maxForwardSteps = Math.max(
        0,
        Math.floor((selectedGraphClip.durationFrames - maxBase) / snap),
      );
      const maxBackwardSteps = Math.max(0, Math.floor(minBase / snap));
      const deltas = [
        0,
        ...Array.from({ length: maxForwardSteps }, (_, index) => (index + 1) * snap),
        ...Array.from({ length: maxBackwardSteps }, (_, index) => -((index + 1) * snap)),
      ];

      for (const delta of deltas) {
        const candidate = baseFrames.map((frame) =>
          Math.max(0, Math.min(selectedGraphClip.durationFrames, frame + delta)),
        );
        const uniqueCandidate = new Set(candidate);
        if (uniqueCandidate.size !== candidate.length) continue;
        if (candidate.every((frame) => !existingFrames.has(frame))) {
          return candidate;
        }
      }

      return baseFrames;
    },
    [selectedGraphClip, toClipLocalFrame, currentFrame, graphSnapStep, getGraphPropertyKeyframes],
  );

  const graphPropertyValueAtPlayhead = useCallback(
    (property: KeyframeProperty): number => {
      if (!selectedGraphClip) return 0;
      switch (property) {
        case 'speed':
          return selectedGraphClip.speed ?? 1;
        case 'volume':
          return selectedGraphClip.gain ?? selectedGraphClip.audioVolume ?? 1;
        case 'pan':
          return selectedGraphClip.pan ?? selectedGraphClip.audioPan ?? 0;
        case 'brightness':
          return selectedGraphClip.brightness ?? 1;
        case 'contrast':
          return selectedGraphClip.contrast ?? 1;
        case 'saturation':
          return selectedGraphClip.saturation ?? 1;
        case 'hue':
          return selectedGraphClip.hue ?? 0;
        case 'vignette':
          return selectedGraphClip.vignette ?? 0;
        case 'transform.positionX':
          return selectedGraphClip.positionX ?? 0;
        case 'transform.positionY':
          return selectedGraphClip.positionY ?? 0;
        case 'transform.scaleX':
          return selectedGraphClip.scaleX ?? 1;
        case 'transform.scaleY':
          return selectedGraphClip.scaleY ?? 1;
        case 'transform.rotation':
          return selectedGraphClip.rotation ?? 0;
        case 'transform.anchorX':
        case 'transform.anchorY':
          return 0.5;
        case 'opacity':
          return selectedGraphClip.opacity ?? 1;
        case 'mask.opacity': {
          const firstMask = selectedGraphClip.masks?.[0];
          return firstMask?.opacity ?? 1;
        }
        case 'mask.feather': {
          const firstMask = selectedGraphClip.masks?.[0];
          return firstMask?.feather ?? 0;
        }
        case 'mask.expansion': {
          const firstMask = selectedGraphClip.masks?.[0];
          return firstMask?.expansion ?? 0;
        }
        default:
          return 0;
      }
    },
    [selectedGraphClip],
  );

  const addGraphKeyframeAtPlayhead = useCallback(
    (property: KeyframeProperty = graphProperty) => {
      if (!selectedGraphClip) return;
      const clipLocalFrame = toClipLocalFrame(selectedGraphClip, currentFrame);
      const propertyKeyframes = getGraphPropertyKeyframes(property);
      const existing = propertyKeyframes.find((kf) => kf.frame === clipLocalFrame);
      const nextId = existing?.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      upsertGraphKeyframeWithLinkedScale(property, {
        id: nextId,
        property,
        frame: clipLocalFrame,
        value: graphPropertyValueAtPlayhead(property),
        easing: existing?.easing ?? 'linear',
        bezierHandles: existing?.bezierHandles,
      });
      pendingGraphSelectionRef.current = { ids: [nextId], primaryId: nextId };
    },
    [
      selectedGraphClip,
      currentFrame,
      toClipLocalFrame,
      getGraphPropertyKeyframes,
      upsertGraphKeyframeWithLinkedScale,
      graphProperty,
      graphPropertyValueAtPlayhead,
    ],
  );

  const updateGraphKeyframe = useCallback(
    (
      keyframeId: string,
      patch: Partial<Pick<TimelineKeyframeData, 'frame' | 'value' | 'easing' | 'bezierHandles'>>,
      propertyOverride?: KeyframeProperty,
    ) => {
      if (!selectedGraphClip) return;
      const property = propertyOverride ?? graphProperty;
      const propertyKeyframes = getGraphPropertyKeyframes(property);
      const existing = propertyKeyframes.find((kf) => kf.id === keyframeId);
      if (!existing) return;
      const nextEasing = patch.easing ?? existing.easing ?? 'linear';
      const nextHandles =
        patch.bezierHandles ??
        (nextEasing === 'bezier'
          ? existing.bezierHandles ?? { outX: 0.25, outY: 0.1, inX: 0.75, inY: 0.9 }
          : existing.bezierHandles);
      const nextLocalFrame =
        patch.frame != null
          ? toClipLocalFrame(selectedGraphClip, patch.frame)
          : existing.frame;
      upsertGraphKeyframeWithLinkedScale(
        property,
        {
        ...existing,
        frame: nextLocalFrame,
        value: patch.value ?? existing.value,
        easing: nextEasing,
        bezierHandles: nextHandles,
        },
        { sourceFrame: existing.frame },
      );
    },
    [
      selectedGraphClip,
      graphProperty,
      getGraphPropertyKeyframes,
      toClipLocalFrame,
      upsertGraphKeyframeWithLinkedScale,
    ],
  );

  const selectedGraphKeyframe = useMemo(
    () => graphPropertyTimelineKeyframes.find((keyframe) => keyframe.id === selectedGraphKeyframeId) ?? null,
    [graphPropertyTimelineKeyframes, selectedGraphKeyframeId],
  );

  const setGraphSelection = useCallback(
    (ids: string[], primaryId?: string | null) => {
      const validIds = new Set(graphPropertyTimelineKeyframes.map((keyframe) => keyframe.id));
      const nextIds = Array.from(new Set(ids)).filter((id) => validIds.has(id));
      const nextPrimary =
        primaryId != null && nextIds.includes(primaryId)
          ? primaryId
          : nextIds.length > 0
            ? nextIds[nextIds.length - 1]!
            : null;
      setSelectedGraphKeyframeIds(nextIds);
      setSelectedGraphKeyframeId(nextPrimary);
    },
    [graphPropertyTimelineKeyframes],
  );

  const applyGraphSelection = useCallback(
    (
      ids: string[],
      primaryId?: string | null,
      options?: {
        additive?: boolean;
      },
    ) => {
      setGraphSelection(options?.additive ? [...selectedGraphKeyframeIds, ...ids] : ids, primaryId);
    },
    [setGraphSelection, selectedGraphKeyframeIds],
  );

  const selectGraphKeyframe = useCallback(
    (
      keyframeId: string,
      options?: {
        additive?: boolean;
        range?: boolean;
      },
    ) => {
      const orderedIds = graphPropertyTimelineKeyframes.map((keyframe) => keyframe.id);
      if (!orderedIds.includes(keyframeId)) return;

      if (options?.range) {
        const anchorId =
          selectedGraphKeyframeId && orderedIds.includes(selectedGraphKeyframeId)
            ? selectedGraphKeyframeId
            : keyframeId;
        const fromIndex = orderedIds.indexOf(anchorId);
        const toIndex = orderedIds.indexOf(keyframeId);
        const rangeIds = orderedIds.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1);
        setGraphSelection(options.additive ? [...selectedGraphKeyframeIds, ...rangeIds] : rangeIds, keyframeId);
        return;
      }

      if (options?.additive) {
        if (selectedGraphKeyframeIds.includes(keyframeId)) {
          const remaining = selectedGraphKeyframeIds.filter((id) => id !== keyframeId);
          setGraphSelection(remaining, remaining[remaining.length - 1] ?? null);
          return;
        }
        setGraphSelection([...selectedGraphKeyframeIds, keyframeId], keyframeId);
        return;
      }

      setGraphSelection([keyframeId], keyframeId);
    },
    [graphPropertyTimelineKeyframes, selectedGraphKeyframeId, selectedGraphKeyframeIds, setGraphSelection],
  );

  const setSelectedGraphKeyframeEasing = useCallback(
    (easing: TimelineKeyframeData['easing']) => {
      const targets =
        selectedGraphKeyframes.length > 0
          ? selectedGraphKeyframes
          : selectedGraphKeyframe
            ? [selectedGraphKeyframe]
            : [];
      for (const keyframe of targets) {
        updateGraphKeyframe(keyframe.id, {
          easing,
          bezierHandles:
            easing === 'bezier'
              ? keyframe.bezierHandles ?? {
                  outX: 0.25,
                  outY: 0.1,
                  inX: 0.75,
                  inY: 0.9,
                }
              : keyframe.bezierHandles,
        });
      }
    },
    [selectedGraphKeyframe, selectedGraphKeyframes, updateGraphKeyframe],
  );

  const toggleGraphKeyframeCurve = useCallback(
    (
      keyframeId: string,
      propertyOverride: KeyframeProperty = graphProperty,
    ) => {
      const existing = getGraphPropertyKeyframes(propertyOverride).find((kf) => kf.id === keyframeId);
      if (!existing) return;
      const nextEasing = existing.easing === 'bezier' ? 'linear' : 'bezier';
      updateGraphKeyframe(keyframeId, {
        easing: nextEasing,
        bezierHandles:
          nextEasing === 'bezier'
            ? existing.bezierHandles ?? { outX: 0.25, outY: 0.1, inX: 0.75, inY: 0.9 }
            : existing.bezierHandles,
      }, propertyOverride);
    },
    [graphProperty, getGraphPropertyKeyframes, updateGraphKeyframe],
  );

  const toggleSelectedGraphKeyframeCurve = useCallback(() => {
    const targets =
      selectedGraphKeyframes.length > 0
        ? selectedGraphKeyframes
        : selectedGraphKeyframe
          ? [selectedGraphKeyframe]
          : [];
    for (const keyframe of targets) {
      toggleGraphKeyframeCurve(keyframe.id, graphProperty);
    }
  }, [selectedGraphKeyframes, selectedGraphKeyframe, toggleGraphKeyframeCurve, graphProperty]);

  const removeSelectedGraphKeyframe = useCallback(() => {
    if (!selectedGraphClip) return;
    const targets =
      selectedGraphKeyframes.length > 0
        ? selectedGraphKeyframes
        : selectedGraphKeyframe
          ? [selectedGraphKeyframe]
          : [];
    if (targets.length === 0) return;
    const linkedProperty = getLinkedScaleGraphProperty(graphProperty);
    const linkedKeyframes = linkedProperty ? getGraphPropertyKeyframes(linkedProperty) : [];
    for (const keyframe of targets) {
      void removeClipKeyframe(selectedGraphClip.id, keyframe.id);
      if (!linkedProperty) continue;
      const localFrame = toClipLocalFrame(selectedGraphClip, keyframe.frame);
      const linkedMatch = linkedKeyframes.find((item) => item.frame === localFrame);
      if (linkedMatch) {
        void removeClipKeyframe(selectedGraphClip.id, linkedMatch.id);
      }
    }
    setGraphSelection([], null);
  }, [
    selectedGraphClip,
    selectedGraphKeyframes,
    selectedGraphKeyframe,
    removeClipKeyframe,
    setGraphSelection,
    getLinkedScaleGraphProperty,
    graphProperty,
    getGraphPropertyKeyframes,
    toClipLocalFrame,
  ]);

  const copySelectedGraphKeyframes = useCallback(() => {
    const source =
      selectedGraphKeyframes.length > 0
        ? [...selectedGraphKeyframes].sort((a, b) => a.frame - b.frame)
        : selectedGraphKeyframe
          ? [selectedGraphKeyframe]
          : [];
    if (source.length === 0) return;
    const baseFrame = source[0]!.frame;
    setGraphKeyframeClipboard({
      property: graphProperty,
      items: source.map((keyframe) => ({
        offsetFrame: keyframe.frame - baseFrame,
        value: keyframe.value,
        easing: keyframe.easing,
        bezierHandles: keyframe.bezierHandles,
      })),
    });
  }, [selectedGraphKeyframes, selectedGraphKeyframe, graphProperty]);

  const pasteGraphKeyframesAtPlayhead = useCallback(() => {
    if (!selectedGraphClip || !graphKeyframeClipboard || graphKeyframeClipboard.property !== graphProperty) return;
    const nextIds: string[] = [];
    const targetLocalFrames = resolveGraphPasteLocalFrames(graphKeyframeClipboard.items, graphProperty);
    graphKeyframeClipboard.items.forEach((item, index) => {
      const targetFrame = targetLocalFrames[index];
      if (targetFrame == null) return;
      const keyframeId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      nextIds.push(keyframeId);
      upsertGraphKeyframeWithLinkedScale(graphProperty, {
        id: keyframeId,
        property: graphProperty,
        frame: targetFrame,
        value: item.value,
        easing: item.easing,
        bezierHandles: item.bezierHandles,
      });
    });
    if (nextIds.length > 0) {
      pendingGraphSelectionRef.current = {
        ids: nextIds,
        primaryId: nextIds[nextIds.length - 1] ?? null,
      };
    }
  }, [
    selectedGraphClip,
    graphKeyframeClipboard,
    graphProperty,
    resolveGraphPasteLocalFrames,
    upsertGraphKeyframeWithLinkedScale,
  ]);

  const handleGraphShortcut = useCallback(
    (event: {
      key: string;
      ctrlKey: boolean;
      metaKey: boolean;
      target: EventTarget | null;
      preventDefault: () => void;
      stopPropagation?: () => void;
      stopImmediatePropagation?: () => void;
    }) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target != null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (isTypingTarget) return false;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        copySelectedGraphKeyframes();
        return true;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        pasteGraphKeyframesAtPlayhead();
        return true;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        removeSelectedGraphKeyframe();
        return true;
      }

      return false;
    },
    [
      copySelectedGraphKeyframes,
      pasteGraphKeyframesAtPlayhead,
      removeSelectedGraphKeyframe,
    ],
  );

  useEffect(() => {
    if (timelineViewMode !== 'graph') return;
    const onKeyDown = (event: KeyboardEvent) => {
      handleGraphShortcut(event);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [
    timelineViewMode,
    handleGraphShortcut,
  ]);

  useEffect(() => {
    if (timelineViewMode !== 'graph') return;
    const frame = window.requestAnimationFrame(() => {
      graphEditorRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [timelineViewMode, graphProperty, selectedGraphClip?.id]);

  const startGraphOverviewMarkerDrag = useCallback(
    (keyframeId: string, clientX: number, container: HTMLDivElement | null) => {
      if (!selectedGraphClip || !container) return;
      const selectedIds =
        selectedGraphKeyframeIds.includes(keyframeId) && selectedGraphKeyframeIds.length > 0
          ? [...selectedGraphKeyframeIds]
          : [keyframeId];
      const selectedSet = new Set(selectedIds);
      const startFrames = Object.fromEntries(
        graphPropertyTimelineKeyframes
          .filter((keyframe) => selectedSet.has(keyframe.id))
          .map((keyframe) => [keyframe.id, keyframe.frame]),
      );
      const snap = Math.max(1, graphSnapStep);
      let minDelta = Number.NEGATIVE_INFINITY;
      let maxDelta = Number.POSITIVE_INFINITY;

      for (let index = 0; index < graphPropertyTimelineKeyframes.length; index++) {
        const keyframe = graphPropertyTimelineKeyframes[index]!;
        if (!selectedSet.has(keyframe.id)) continue;
        const prevUnselected = [...graphPropertyTimelineKeyframes.slice(0, index)]
          .reverse()
          .find((candidate) => !selectedSet.has(candidate.id));
        const nextUnselected = graphPropertyTimelineKeyframes
          .slice(index + 1)
          .find((candidate) => !selectedSet.has(candidate.id));
        minDelta = Math.max(minDelta, (prevUnselected?.frame ?? 0) + (prevUnselected ? snap : 0) - keyframe.frame);
        maxDelta = Math.min(
          maxDelta,
          (nextUnselected?.frame ?? graphClipEndFrame) - (nextUnselected ? snap : 0) - keyframe.frame,
        );
      }

      graphMarkerDragRef.current = {
        clipId: selectedGraphClip.id,
        property: graphProperty,
        container,
        anchorClientX: clientX,
        selectedIds,
        startFrames,
        minDelta,
        maxDelta,
      };
    },
    [
      selectedGraphClip,
      selectedGraphKeyframeIds,
      graphPropertyTimelineKeyframes,
      graphSnapStep,
      graphClipEndFrame,
      graphProperty,
    ],
  );

  const clickGraphTimelineFrame = useCallback(
    (clientX: number, element: HTMLDivElement | null) => {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      setCurrentFrame(Math.max(0, Math.round(pct * timelineGraphEndFrame)));
    },
    [setCurrentFrame, timelineGraphEndFrame],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (graphMarkerDragRef.current) {
        const drag = graphMarkerDragRef.current;
        const rect = drag.container.getBoundingClientRect();
        const startPct = Math.max(0, Math.min(1, (drag.anchorClientX - rect.left) / Math.max(1, rect.width)));
        const currentPct = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
        const rawDelta = (currentPct - startPct) * timelineGraphEndFrame;
        const snap = Math.max(1, graphSnapStep);
        const snappedDelta = Math.round(rawDelta / snap) * snap;
        const boundedDelta = Math.max(drag.minDelta, Math.min(drag.maxDelta, snappedDelta));
        setGraphMarkerDraftFrames(
          Object.fromEntries(
            drag.selectedIds.map((id) => [id, Math.max(0, Math.round((drag.startFrames[id] ?? 0) + boundedDelta))]),
          ),
        );
        return;
      }
      if (!graphScrubRef.current) return;
      clickGraphTimelineFrame(e.clientX, graphScrubRef.current);
    };
    const onUp = () => {
      if (graphMarkerDragRef.current) {
        const drag = graphMarkerDragRef.current;
        const draftFrames = { ...graphMarkerDraftFrames };
        graphMarkerDragRef.current = null;
        setGraphMarkerDraftFrames({});
        for (const id of drag.selectedIds) {
          const nextFrame = draftFrames[id];
          if (nextFrame == null) continue;
          updateGraphKeyframe(id, { frame: nextFrame }, drag.property);
        }
      }
      graphScrubRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [clickGraphTimelineFrame, graphMarkerDraftFrames, graphSnapStep, timelineGraphEndFrame, updateGraphKeyframe]);

  const jumpGraphKeyframe = useCallback(
    (direction: -1 | 1, property: KeyframeProperty = graphProperty) => {
      if (!selectedGraphClip) return;
      const propertyKeyframes = getGraphPropertyKeyframes(property);
      if (propertyKeyframes.length === 0) return;
      const timelineKeyframes = propertyKeyframes.map((kf) => ({
        ...kf,
        timelineFrame: selectedGraphClip.startFrame + kf.frame,
      }));
      if (direction < 0) {
        const prev = [...timelineKeyframes].reverse().find((kf) => kf.timelineFrame < currentFrame);
        const target = prev ?? timelineKeyframes[0];
        setCurrentFrame(Math.max(0, target.timelineFrame));
        setGraphSelection([target.id], target.id);
        return;
      }
      const next = timelineKeyframes.find((kf) => kf.timelineFrame > currentFrame);
      const target = next ?? timelineKeyframes[timelineKeyframes.length - 1];
      setCurrentFrame(Math.max(0, target.timelineFrame));
      setGraphSelection([target.id], target.id);
    },
    [
      selectedGraphClip,
      getGraphPropertyKeyframes,
      currentFrame,
      setCurrentFrame,
      graphProperty,
      setGraphSelection,
    ],
  );

  useEffect(() => {
    if (timelineViewMode !== 'graph') return;
    if (timelineTool !== 'select') {
      setTimelineTool('select');
    }
  }, [timelineViewMode, timelineTool, setTimelineTool]);

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
      if (keyframeDragRef.current) {
        const drag = keyframeDragRef.current;
        const deltaFrames = Math.round((e.clientX - drag.startX) / pxPerFrame);
        const nextFrame = Math.max(
          0,
          Math.min(drag.clipDurationFrames, drag.origFrame + deltaFrames),
        );
        setKeyframeDragFrame(nextFrame);
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

      const drag = dragRef.current;
      const supportsRipple =
        drag.mode === 'move' || drag.mode === 'trim-left' || drag.mode === 'trim-right';
      setIsRipple(supportsRipple && rippleMode);

      if (drag.mode === 'transition-in' || drag.mode === 'transition-out') {
        setSnapLineFrame(null);
        return;
      }

      // --- Snap computation ---
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
      if (keyframeDragRef.current) {
        const drag = keyframeDragRef.current;
        const finalFrame = keyframeDragFrame ?? drag.origFrame;
        keyframeDragRef.current = null;
        setKeyframeDragFrame(null);

        if (finalFrame !== drag.origFrame) {
          let keyframeToCommit: (TimelineClipKeyframe & {
            easing?: TimelineKeyframeData['easing'];
          }) | null = null;
          for (const track of tracks) {
            const clip = track.clips.find((c) => c.id === drag.clipId);
            if (!clip) continue;
            const kf = (clip.keyframes ?? []).find((item) => item.id === drag.keyframeId);
            if (kf) {
              keyframeToCommit = kf as TimelineClipKeyframe & {
                easing?: TimelineKeyframeData['easing'];
              };
            }
            break;
          }
          if (keyframeToCommit) {
            void upsertClipKeyframe(drag.clipId, {
              id: keyframeToCommit.id,
              property: keyframeToCommit.property as TimelineKeyframeData['property'],
              frame: finalFrame,
              value: keyframeToCommit.value,
              easing: keyframeToCommit.easing ?? 'linear',
              bezierHandles: keyframeToCommit.bezierHandles,
            });
          }
        }
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
      } else if (drag.mode === 'transition-in' || drag.mode === 'transition-out') {
        const side = drag.mode === 'transition-in' ? 'in' : 'out';
        const baseDuration = Math.max(1, Math.round(drag.origTransitionDurationFrames ?? 1));
        const requestedDuration = Math.max(
          1,
          baseDuration + (side === 'in' ? deltaFrames : -deltaFrames),
        );
        const type = drag.transitionType ?? 'cross-dissolve';
        void setClipTransition(drag.clipId, side, {
          id: drag.transitionId ?? `${drag.clipId}-${side}-transition`,
          type,
          durationFrames: requestedDuration,
          audioCrossfade:
            drag.transitionAudioCrossfade ?? (type === 'cross-dissolve'),
        });
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
    keyframeDragFrame,
    dragDelta,
    getTrackIdFromClientY,
    rippleMode,
    linkedSelection,
    isTrackLocked,
    upsertClipKeyframe,
    setClipTransition,
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

  const handleTransitionHandleMouseDown = useCallback(
    (
      clip: TimelineClip,
      trackId: string,
      side: 'in' | 'out',
      transition: NonNullable<TimelineClip['transitionIn']>,
      e: React.MouseEvent,
    ) => {
      e.stopPropagation();
      e.preventDefault();
      if (isTrackLocked(trackId) || timelineTool === 'razor') return;

      setActivePanel('timeline');
      selectClip(clip.id, e.shiftKey || e.ctrlKey || e.metaKey);

      dragRef.current = {
        mode: side === 'in' ? 'transition-in' : 'transition-out',
        clipId: clip.id,
        trackId,
        origStartFrame: clip.startFrame,
        origDurationFrames: clip.durationFrames,
        transitionId: transition.id,
        transitionType: normalizeTransitionType(transition.type),
        transitionAudioCrossfade: transition.audioCrossfade,
        origTransitionDurationFrames: Math.max(1, Math.round(transition.durationFrames)),
        startX: e.clientX,
      };
      setDragDelta(0);
      setSnapLineFrame(null);
      setIsRipple(false);
    },
    [isTrackLocked, timelineTool, setActivePanel, selectClip],
  );

  const handleKeyframeMouseDown = useCallback(
    (
      clip: TimelineClip,
      keyframe: TimelineClipKeyframe,
      e: React.MouseEvent,
    ) => {
      e.stopPropagation();
      e.preventDefault();
      if (timelineTool === 'razor') return;
      setActivePanel('timeline');
      selectClip(clip.id, e.shiftKey || e.ctrlKey || e.metaKey);
      setCurrentFrame(Math.max(0, Math.round(clip.startFrame + keyframe.frame)));
      keyframeDragRef.current = {
        clipId: clip.id,
        keyframeId: keyframe.id,
        startX: e.clientX,
        origFrame: Math.max(0, Math.round(keyframe.frame)),
        clipDurationFrames: Math.max(1, clip.durationFrames),
      };
      setKeyframeDragFrame(Math.max(0, Math.round(keyframe.frame)));
    },
    [timelineTool, setActivePanel, selectClip, setCurrentFrame],
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

  const resolveDropTrack = useCallback(
    (asset: Pick<ApiMediaAsset, 'type'>, initialTrack: TimelineTrack | null): TimelineTrack | null => {
      const expectedType = asset.type === 'audio' ? 'audio' : 'video';
      if (initialTrack && initialTrack.type === expectedType) {
        return initialTrack;
      }

      const isAudio = asset.type === 'audio';
      const videoTracks = tracks.filter((track) => track.type === 'video');
      const audioTracks = tracks.filter((track) => track.type === 'audio');
      const preferredVideo =
        videoTracks.find((track) => track.name.trim().toUpperCase() === 'V1') ??
        [...videoTracks].sort((a, b) => a.index - b.index)[0];
      const preferredAudio =
        audioTracks.find((track) => track.name.trim().toUpperCase() === 'A1') ??
        [...audioTracks].sort((a, b) => a.index - b.index)[0];
      return (isAudio ? preferredAudio : preferredVideo) ?? tracks[0] ?? null;
    },
    [tracks],
  );

  const estimateDroppedClipFrames = useCallback(
    (asset: ApiMediaAsset): number => {
      const baseDuration = asset.duration != null && asset.duration > 0 ? asset.duration : 5;
      return Math.max(1, Math.round(baseDuration * fps));
    },
    [fps],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOverFiles(false);

      // Native OS file drops
      if (e.dataTransfer.files.length > 0) {
        const mediaFiles = new Map<string, File>();
        for (const file of e.dataTransfer.files) {
          const ext = '.' + file.name.split('.').pop()?.toLowerCase();
          if (
            MEDIA_EXTENSIONS.has(ext) ||
            file.type.startsWith('video/') ||
            file.type.startsWith('audio/') ||
            file.type.startsWith('image/')
          ) {
            const signature = [file.name, file.size, file.lastModified, file.type].join(':');
            mediaFiles.set(signature, file);
          }
        }
        if (mediaFiles.size > 0) {
          const droppedFiles = [...mediaFiles.values()];
          const container = containerRef.current;
          const suggestedTrack = getTrackFromDropY(e);
          const rect = container?.getBoundingClientRect();
          const x = rect ? e.clientX - rect.left + container!.scrollLeft : 0;
          let cursorFrame = Math.max(0, Math.round(x / pxPerFrame));
          const importedAssets = await uploadMedia(droppedFiles);
          for (const asset of importedAssets) {
            const targetTrack = resolveDropTrack(asset, suggestedTrack);
            if (!targetTrack) continue;
            await addClipToTrack({
              trackId: targetTrack.id,
              asset,
              startFrame: cursorFrame,
              insertMode: rippleMode ? 'ripple' : 'overwrite',
            });
            cursorFrame += estimateDroppedClipFrames(asset);
          }
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
          const targetTrack = resolveDropTrack(effectiveAsset, getTrackFromDropY(e));
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
          const targetTrack = resolveDropTrack(asset, getTrackFromDropY(e));
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
      resolveDropTrack,
      estimateDroppedClipFrames,
      pxPerFrame,
      rippleMode,
      maybePromptFirstClipProjectMatch,
    ],
  );

  const handleDragOverTimeline = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
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
    e.stopPropagation();
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
          <div className="ml-2 flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800/50 p-0.5">
            <button
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                timelineViewMode === 'timeline'
                  ? 'bg-blue-500/25 text-blue-200'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setTimelineViewMode('timeline')}
              title="Classic timeline view"
            >
              Timeline
            </button>
            <button
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                timelineViewMode === 'graph'
                  ? 'bg-blue-500/25 text-blue-200'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setTimelineViewMode('graph')}
              title="Graph editor view"
            >
              Graph
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {timelineViewMode === 'graph' ? (
            <div className="flex items-center gap-1">
              <span className="rounded bg-zinc-700/40 px-1.5 py-0.5 text-[10px] text-zinc-300">
                {selectedGraphClip
                  ? `${selectedGraphClip.name} @ ${currentFrame}f`
                  : 'No clip selected'}
              </span>
              <span className="rounded bg-zinc-700/30 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {KEYFRAME_PROPERTIES.find((property) => property.value === graphProperty)?.label ??
                  graphProperty}
              </span>
            </div>
          ) : (
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
              -
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
              PM
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
              NM
            </button>
            <span className="rounded bg-zinc-700/40 px-1 py-0.5 text-[9px] text-fuchsia-300">
              {markers.length}m
            </span>
            </div>
          )}
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
      {timelineViewMode === 'graph' ? (
        <div
          ref={graphEditorRef}
          tabIndex={0}
          className="flex flex-1 overflow-hidden focus:outline-none focus:ring-1 focus:ring-blue-500/40"
          onMouseDown={() => graphEditorRef.current?.focus()}
          onKeyDown={(event) => {
            handleGraphShortcut(event.nativeEvent);
          }}
        >
          <div className="flex flex-1 flex-col overflow-hidden px-3 py-2">
            {!selectedGraphClip ? (
              <div className="flex flex-1 items-center justify-center rounded border border-zinc-700 bg-zinc-900/40 text-sm text-zinc-500">
                Select one clip in the timeline to edit keyframes.
              </div>
            ) : (
              <>
                <div className="mb-2 rounded border border-zinc-700 bg-zinc-900/40 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-zinc-500">Clip</span>
                      <span className="rounded bg-zinc-700/40 px-1.5 py-0.5 text-[10px] text-zinc-200">
                        {selectedGraphClip.name}
                      </span>
                      <span className="rounded bg-zinc-700/40 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                        {currentFrame}f
                      </span>
                      <span className="rounded bg-zinc-700/30 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {KEYFRAME_PROPERTIES.find((property) => property.value === graphProperty)?.label ??
                          graphProperty}
                      </span>
                    </div>
                    <button
                      className="rounded bg-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-600"
                      onClick={() => setTimelineViewMode('timeline')}
                    >
                      Back to Timeline
                    </button>
                  </div>

                  <div
                    className="relative mt-2 h-14 rounded border border-zinc-700 bg-zinc-950/70"
                    onMouseDown={(e) => {
                      graphScrubRef.current = e.currentTarget;
                      clickGraphTimelineFrame(e.clientX, e.currentTarget);
                    }}
                  >
                    <div className="absolute inset-x-0 top-0 h-6 border-b border-zinc-800/80">
                      {Array.from({ length: 11 }).map((_, index) => {
                        const pct = index / 10;
                        const frame = Math.round(pct * timelineGraphEndFrame);
                        return (
                          <div
                            key={`graph-tick-${frame}`}
                            className="absolute top-0 bottom-0"
                            style={{ left: `${pct * 100}%` }}
                          >
                            <div className="h-2 w-px bg-zinc-700" />
                            <div className="mt-1 -translate-x-1/2 font-mono text-[9px] text-zinc-500">
                              {frame}f
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div ref={graphOverviewRef} className="absolute inset-x-0 bottom-0 top-6">
                      {effectiveGraphPropertyTimelineKeyframes.map((marker) => {
                        const pct = Math.max(0, Math.min(1, marker.frame / Math.max(1, timelineGraphEndFrame)));
                        const isSelected = selectedGraphKeyframeIds.includes(marker.id);
                        return (
                          <button
                            key={`overview-${graphProperty}-${marker.id}`}
                            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${
                              isSelected
                                ? 'border-amber-100 bg-amber-300'
                                : 'border-blue-100 bg-blue-300'
                            }`}
                            style={{
                              left: `${pct * 100}%`,
                              backgroundColor: isSelected ? undefined : keyframeColor(graphProperty),
                            }}
                            title={`${KEYFRAME_PROPERTIES.find((property) => property.value === graphProperty)?.label ?? graphProperty} @ ${marker.frame}f`}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              selectGraphKeyframe(marker.id, {
                                additive: e.ctrlKey || e.metaKey,
                                range: e.shiftKey,
                              });
                              setCurrentFrame(Math.max(0, Math.round(marker.frame)));
                              if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
                                startGraphOverviewMarkerDrag(marker.id, e.clientX, graphOverviewRef.current);
                              }
                            }}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              selectGraphKeyframe(marker.id);
                              toggleGraphKeyframeCurve(marker.id, graphProperty);
                            }}
                          />
                        );
                      })}
                      <div
                        className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-blue-400"
                        style={{
                          left: `${Math.max(0, Math.min(1, currentFrame / Math.max(1, timelineGraphEndFrame))) * 100}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <select
                      value={graphSnapStep}
                      onChange={(e) => setGraphSnapStep(Math.max(1, Number(e.target.value) || 1))}
                      className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[10px] text-zinc-300"
                      title="Graph drag snap (frames)"
                    >
                      <option value={1}>Snap 1f</option>
                      <option value={2}>Snap 2f</option>
                      <option value={5}>Snap 5f</option>
                      <option value={10}>Snap 10f</option>
                    </select>
                    <IconActionButton
                      title="Previous keyframe"
                      onClick={() => jumpGraphKeyframe(-1)}
                      disabled={graphPropertyKeyframes.length === 0}
                    >
                      <PrevGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title="Add/update keyframe at playhead"
                      onClick={() => addGraphKeyframeAtPlayhead()}
                    >
                      <AddKeyGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title="Next keyframe"
                      onClick={() => jumpGraphKeyframe(1)}
                      disabled={graphPropertyKeyframes.length === 0}
                    >
                      <NextGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title={
                        selectedGraphKeyframeIds.length > 1
                          ? 'Remove selected keyframes'
                          : 'Remove selected keyframe'
                      }
                      onClick={removeSelectedGraphKeyframe}
                      disabled={!selectedGraphKeyframe && selectedGraphKeyframeIds.length === 0}
                      destructive
                    >
                      <TrashGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title="Copy selected keyframes"
                      onClick={copySelectedGraphKeyframes}
                      disabled={!selectedGraphKeyframe && selectedGraphKeyframeIds.length === 0}
                    >
                      <CopyGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title="Paste copied keyframes at playhead"
                      onClick={pasteGraphKeyframesAtPlayhead}
                      disabled={!graphKeyframeClipboard || graphKeyframeClipboard.property !== graphProperty}
                    >
                      <PasteGlyph />
                    </IconActionButton>
                    <div className="mx-1 h-5 w-px bg-zinc-700" />
                    <IconActionButton
                      title="Linear interpolation"
                      onClick={() => setSelectedGraphKeyframeEasing('linear')}
                      disabled={!selectedGraphKeyframe && selectedGraphKeyframeIds.length === 0}
                      active={selectedGraphKeyframe?.easing === 'linear'}
                    >
                      <LinearGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title="Ease in"
                      onClick={() => setSelectedGraphKeyframeEasing('ease-in')}
                      disabled={!selectedGraphKeyframe && selectedGraphKeyframeIds.length === 0}
                      active={selectedGraphKeyframe?.easing === 'ease-in'}
                    >
                      <EaseInGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title="Ease out"
                      onClick={() => setSelectedGraphKeyframeEasing('ease-out')}
                      disabled={!selectedGraphKeyframe && selectedGraphKeyframeIds.length === 0}
                      active={selectedGraphKeyframe?.easing === 'ease-out'}
                    >
                      <EaseOutGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title="Ease in/out"
                      onClick={() => setSelectedGraphKeyframeEasing('ease-in-out')}
                      disabled={!selectedGraphKeyframe && selectedGraphKeyframeIds.length === 0}
                      active={selectedGraphKeyframe?.easing === 'ease-in-out'}
                    >
                      <EaseInOutGlyph />
                    </IconActionButton>
                    <IconActionButton
                      title="Bezier / smooth"
                      onClick={toggleSelectedGraphKeyframeCurve}
                      disabled={!selectedGraphKeyframe && selectedGraphKeyframeIds.length === 0}
                      active={selectedGraphKeyframe?.easing === 'bezier'}
                    >
                      <BezierGlyph />
                    </IconActionButton>
                    <button
                      className={`ml-2 rounded px-2 py-1 text-[10px] ${
                        autoKeyframeEnabled
                          ? 'bg-emerald-700/80 text-white hover:bg-emerald-600'
                          : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                      }`}
                      onClick={() => setAutoKeyframeEnabled(!autoKeyframeEnabled)}
                      title="Auto-create keyframes while changing animated properties"
                    >
                      {autoKeyframeEnabled ? 'Auto' : 'Auto Off'}
                    </button>
                  </div>
                </div>
                <div className="flex min-h-[30rem] flex-1 gap-3">
                  <div className="w-44 overflow-y-auto rounded border border-zinc-700 bg-zinc-900/40 p-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                      Property Lanes
                    </div>
                    <div className="space-y-1">
                      {graphPropertiesWithKeyframes.length === 0 && (
                        <div className="rounded border border-zinc-700 bg-zinc-900/40 px-2 py-2 text-[10px] text-zinc-500">
                          No keyframed properties yet.
                        </div>
                      )}
                      {graphPropertiesWithKeyframes.map((property) => {
                        const rowKeyframes = getGraphPropertyKeyframes(property.value);
                        const isActive = graphProperty === property.value;
                        return (
                          <div
                            key={property.value}
                            className={`rounded border p-1 ${
                              isActive ? 'border-blue-500/50 bg-blue-500/10' : 'border-zinc-700 bg-zinc-900/30'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <button
                                className={`rounded px-1 py-0.5 text-[10px] ${
                                  isActive
                                    ? 'bg-blue-500/20 text-blue-100'
                                    : 'text-zinc-300 hover:bg-zinc-700'
                                }`}
                                onClick={() => setGraphProperty(property.value)}
                                title="Focus this property in curve editor"
                              >
                                {property.label}
                              </button>
                              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                                {rowKeyframes.length}
                              </span>
                            </div>
                            <div
                              className="mt-1 relative h-5 rounded bg-zinc-950/70"
                              onMouseDown={(e) => {
                                graphScrubRef.current = e.currentTarget;
                                clickGraphTimelineFrame(e.clientX, e.currentTarget);
                              }}
                            >
                              <div
                                className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-blue-400/90"
                                style={{
                                  left: `${Math.max(0, Math.min(1, currentFrame / Math.max(1, timelineGraphEndFrame))) * 100}%`,
                                }}
                              />
                              {rowKeyframes.map((keyframe) => {
                                const timelineFrame = selectedGraphClip.startFrame + keyframe.frame;
                                const pct = Math.max(
                                  0,
                                  Math.min(1, timelineFrame / Math.max(1, timelineGraphEndFrame)),
                                );
                                const isSelected = selectedGraphKeyframeIds.includes(keyframe.id);
                                return (
                                  <button
                                    key={`${property.value}-${keyframe.id}`}
                                    className={`absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rotate-45 border ${
                                      isSelected
                                        ? 'border-amber-100 bg-amber-300'
                                        : isActive
                                          ? 'border-blue-100 bg-blue-300'
                                          : 'border-zinc-900 bg-zinc-200'
                                    }`}
                                    style={{
                                      left: `${pct * 100}%`,
                                      backgroundColor: isSelected ? undefined : keyframeColor(property.value),
                                    }}
                                    title={`${property.label} @ ${timelineFrame}f`}
                                    onMouseDown={(e) => {
                                      e.stopPropagation();
                                      setGraphProperty(property.value);
                                      setCurrentFrame(Math.max(0, Math.round(timelineFrame)));
                                      if (property.value === graphProperty) {
                                        selectGraphKeyframe(keyframe.id, {
                                          additive: e.ctrlKey || e.metaKey,
                                          range: e.shiftKey,
                                        });
                                      } else {
                                        setSelectedGraphKeyframeId(keyframe.id);
                                        setSelectedGraphKeyframeIds([keyframe.id]);
                                      }
                                    }}
                                    onDoubleClick={(e) => {
                                      e.stopPropagation();
                                      setGraphProperty(property.value);
                                      setSelectedGraphKeyframeId(keyframe.id);
                                      setSelectedGraphKeyframeIds([keyframe.id]);
                                      toggleGraphKeyframeCurve(keyframe.id, property.value);
                                    }}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="min-w-0 flex flex-1 flex-col">
                    <KeyframeMiniGraph
                      keyframes={graphPropertyTimelineKeyframes}
                      clipDuration={timelineGraphEndFrame}
                      property={graphProperty}
                      currentFrame={currentFrame}
                      snapStep={graphSnapStep}
                      selectedKeyframeId={selectedGraphKeyframeId}
                      selectedKeyframeIds={selectedGraphKeyframeIds}
                      onSelectKeyframe={(keyframeId, options) =>
                        selectGraphKeyframe(keyframeId, {
                          additive: options?.additive,
                          range: options?.range,
                        })
                      }
                      onSetSelection={applyGraphSelection}
                      onToggleKeyframeCurve={(keyframeId) => toggleGraphKeyframeCurve(keyframeId, graphProperty)}
                      onCommit={(keyframeId, patch) =>
                        updateGraphKeyframe(keyframeId, {
                          frame: patch.frame,
                          value: patch.value,
                          bezierHandles: patch.bezierHandles,
                        })
                      }
                    />
                    <div className="mt-2 text-[10px] text-zinc-500">
                      Drag markers in the top strip to retime selected keyframes. Ctrl/Cmd adds to selection, Shift
                      selects a range, copy/paste works per property, wheel zooms, Shift+Wheel pans, middle mouse
                      pans the curve view, and double-click toggles smooth handles. Hold Alt while dragging a handle
                      to break symmetry.
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
          <aside className="w-12 flex-shrink-0 border-l border-zinc-700 bg-zinc-900/85 px-1 py-2">
            <AudioMeters left={audioMeterLeft} right={audioMeterRight} />
          </aside>
        </div>
      ) : (
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
                    Lk
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
                  const drag = dragRef.current;
                  const dragDeltaFrames = Math.round(dragDelta / pxPerFrame);
                  const isTransitionInDragging =
                    drag?.clipId === clip.id && drag.mode === 'transition-in';
                  const isTransitionOutDragging =
                    drag?.clipId === clip.id && drag.mode === 'transition-out';

                  const transitionInDuration =
                    clip.transitionIn == null
                      ? null
                      : Math.max(
                          1,
                          Math.round(
                            isTransitionInDragging
                              ? (drag.origTransitionDurationFrames ?? clip.transitionIn.durationFrames) +
                                  dragDeltaFrames
                              : clip.transitionIn.durationFrames,
                          ),
                        );
                  const transitionOutDuration =
                    clip.transitionOut == null
                      ? null
                      : Math.max(
                          1,
                          Math.round(
                            isTransitionOutDragging
                              ? (drag.origTransitionDurationFrames ?? clip.transitionOut.durationFrames) -
                                  dragDeltaFrames
                              : clip.transitionOut.durationFrames,
                          ),
                        );

                  const transitionInLimit =
                    clip.transitionIn && transitionInDuration != null
                      ? computeTransitionSideLimit({
                          track: track as TransitionLimitInputTrack,
                          clip: clip as TransitionLimitInputClip,
                          side: 'in',
                          type: normalizeTransitionType(clip.transitionIn.type),
                          requestedDurationFrames: transitionInDuration,
                          mediaAssets,
                          fps,
                        })
                      : null;
                  const transitionOutLimit =
                    clip.transitionOut && transitionOutDuration != null
                      ? computeTransitionSideLimit({
                          track: track as TransitionLimitInputTrack,
                          clip: clip as TransitionLimitInputClip,
                          side: 'out',
                          type: normalizeTransitionType(clip.transitionOut.type),
                          requestedDurationFrames: transitionOutDuration,
                          mediaAssets,
                          fps,
                        })
                      : null;

                  const transitionInMax = transitionInLimit?.maxDurationFrames ?? Math.max(1, clip.durationFrames);
                  const transitionOutMax = transitionOutLimit?.maxDurationFrames ?? Math.max(1, clip.durationFrames);
                  const transitionInOverLimit =
                    transitionInDuration != null && transitionInDuration > transitionInMax;
                  const transitionOutOverLimit =
                    transitionOutDuration != null && transitionOutDuration > transitionOutMax;

                  const transitionInWidthPx =
                    transitionInDuration == null
                      ? 0
                      : Math.max(6, Math.min(style.width * 0.35, transitionInDuration * pxPerFrame));
                  const transitionOutWidthPx =
                    transitionOutDuration == null
                      ? 0
                      : Math.max(6, Math.min(style.width * 0.35, transitionOutDuration * pxPerFrame));
                  const resolveVisualKeyframeFrame = (
                    keyframe: TimelineClipKeyframe,
                  ): number => {
                    if (
                      keyframeDragRef.current?.clipId === clip.id &&
                      keyframeDragRef.current?.keyframeId === keyframe.id &&
                      keyframeDragFrame != null
                    ) {
                      return keyframeDragFrame;
                    }
                    return keyframe.frame;
                  };
                  const hasKeyframeLane = (clip.keyframes?.length ?? 0) > 0 && style.width > 24;
                  const showClipKeyframeMarkers = false;
                  const clipSpeed = clip.speed ?? 1;
                  const showSpeedBadge = Math.abs(clipSpeed - 1) > 0.001;
                  const speedBadge =
                    clipSpeed < 0
                      ? `REV ${Math.round(Math.abs(clipSpeed) * 100)}%`
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
                      {showClipKeyframeMarkers && (clip.keyframes?.length ?? 0) > 0 && (
                        <div className="pointer-events-none absolute left-1 right-1 top-4 h-2">
                          {clip.keyframes!.map((kf) => {
                            const pct = Math.max(
                              0,
                              Math.min(1, resolveVisualKeyframeFrame(kf) / Math.max(1, clip.durationFrames)),
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
                      {showClipKeyframeMarkers && hasKeyframeLane && (
                        <div className="absolute bottom-2 left-1 right-1 h-2 rounded bg-black/25">
                          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-zinc-300/20" />
                          {clip.keyframes!.map((kf) => {
                            const frame = resolveVisualKeyframeFrame(kf);
                            const pct = Math.max(0, Math.min(1, frame / Math.max(1, clip.durationFrames)));
                            const isDragged =
                              keyframeDragRef.current?.clipId === clip.id &&
                              keyframeDragRef.current?.keyframeId === kf.id;
                            return (
                              <div
                                key={`lane-${kf.id}`}
                                className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${
                                  isDragged
                                    ? 'border-white bg-white/90'
                                    : 'border-zinc-950 bg-zinc-100/85 hover:scale-110'
                                }`}
                                style={{ left: `${pct * 100}%`, backgroundColor: keyframeColor(kf.property) }}
                                title={`${kf.property} @ ${Math.round(frame)}f`}
                                onMouseDown={(e) => handleKeyframeMouseDown(clip, kf, e)}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  setCurrentFrame(
                                    Math.max(0, Math.round(clip.startFrame + resolveVisualKeyframeFrame(kf))),
                                  );
                                }}
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
                            borderRightWidth: `${transitionInWidthPx}px`,
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
                            borderLeftWidth: `${transitionOutWidthPx}px`,
                          }}
                        />
                      )}
                      {clip.transitionIn && (
                        <div
                          className={`absolute top-1 bottom-1 w-1.5 rounded-sm ${
                            timelineTool === 'razor'
                              ? 'pointer-events-none opacity-20'
                              : 'cursor-ew-resize bg-cyan-300/25 hover:bg-cyan-300/60'
                          } ${isTransitionInDragging ? 'bg-cyan-200/80' : ''}`}
                          style={{ left: Math.max(2, transitionInWidthPx - 2) }}
                          title="Drag to adjust Transition In duration"
                          onMouseDown={(e) => {
                            if (!clip.transitionIn) return;
                            handleTransitionHandleMouseDown(
                              clip,
                              track.id,
                              'in',
                              clip.transitionIn,
                              e,
                            );
                          }}
                        />
                      )}
                      {clip.transitionOut && (
                        <div
                          className={`absolute top-1 bottom-1 w-1.5 rounded-sm ${
                            timelineTool === 'razor'
                              ? 'pointer-events-none opacity-20'
                              : 'cursor-ew-resize bg-cyan-300/25 hover:bg-cyan-300/60'
                          } ${isTransitionOutDragging ? 'bg-cyan-200/80' : ''}`}
                          style={{ right: Math.max(2, transitionOutWidthPx - 2) }}
                          title="Drag to adjust Transition Out duration"
                          onMouseDown={(e) => {
                            if (!clip.transitionOut) return;
                            handleTransitionHandleMouseDown(
                              clip,
                              track.id,
                              'out',
                              clip.transitionOut,
                              e,
                            );
                          }}
                        />
                      )}
                      {clip.transitionIn &&
                        (isTransitionInDragging || transitionInOverLimit) &&
                        transitionInDuration != null && (
                          <div
                            className={`pointer-events-none absolute left-1 top-5 z-20 rounded px-1 font-mono text-[9px] ${
                              transitionInOverLimit
                                ? 'bg-amber-400/90 text-black'
                                : 'bg-zinc-900/80 text-cyan-200'
                            }`}
                          >
                            {transitionInOverLimit
                              ? `IN ${transitionInDuration}f -> ${transitionInMax}f`
                              : `IN ${transitionInDuration}f`}
                          </div>
                        )}
                      {clip.transitionOut &&
                        (isTransitionOutDragging || transitionOutOverLimit) &&
                        transitionOutDuration != null && (
                          <div
                            className={`pointer-events-none absolute right-1 top-5 z-20 rounded px-1 font-mono text-[9px] ${
                              transitionOutOverLimit
                                ? 'bg-amber-400/90 text-black'
                                : 'bg-zinc-900/80 text-cyan-200'
                            }`}
                          >
                            {transitionOutOverLimit
                              ? `OUT ${transitionOutDuration}f -> ${transitionOutMax}f`
                              : `OUT ${transitionOutDuration}f`}
                          </div>
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
      )}

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


