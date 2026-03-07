import { describe, it, expect } from 'vitest';
import type { ApiMediaAsset } from '../lib/api.js';
import type { TimelineClipData, TimelineTrackData } from './projectStore.js';
import { computeTransitionSideLimit } from './projectStore.js';

function createClip(partial: Partial<TimelineClipData>): TimelineClipData {
  return {
    id: partial.id ?? 'clip',
    name: partial.name ?? 'Clip',
    type: partial.type ?? 'video',
    startFrame: partial.startFrame ?? 0,
    durationFrames: partial.durationFrames ?? 100,
    mediaAssetId: partial.mediaAssetId ?? 'm1',
    sourceInFrame: partial.sourceInFrame ?? 0,
    sourceOutFrame:
      partial.sourceOutFrame ??
      ((partial.sourceInFrame ?? 0) + (partial.durationFrames ?? 100)),
    ...partial,
  };
}

function createTrack(clips: TimelineClipData[]): TimelineTrackData {
  return {
    id: 'v1',
    sequenceId: 'seq1',
    name: 'V1',
    type: 'video',
    index: 0,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips,
  };
}

function createMedia(id: string, duration: number): ApiMediaAsset {
  return {
    id,
    projectId: 'p1',
    name: id,
    type: 'video',
    filePath: `${id}.mp4`,
    mimeType: 'video/mp4',
    fileSize: 0,
    duration,
    frameRate: { num: 24, den: 1 },
    resolution: { width: 1920, height: 1080 },
    audioChannels: 2,
    audioSampleRate: 48000,
    codec: 'h264',
    importedAt: '2026-01-01T00:00:00.000Z',
    thumbnailPath: null,
    waveformDataPath: null,
    proxy: null,
    metadata: {},
  };
}

describe('computeTransitionSideLimit', () => {
  it('clamps cross-dissolve by both clips handle availability at the cut', () => {
    const left = createClip({
      id: 'left',
      startFrame: 0,
      durationFrames: 100,
      mediaAssetId: 'm1',
      sourceInFrame: 50,
      sourceOutFrame: 150,
    });
    const right = createClip({
      id: 'right',
      startFrame: 100,
      durationFrames: 100,
      mediaAssetId: 'm2',
      sourceInFrame: 30,
      sourceOutFrame: 130,
    });
    const track = createTrack([left, right]);
    const media = [createMedia('m1', 10), createMedia('m2', 10)];

    const limit = computeTransitionSideLimit({
      track,
      clip: left,
      side: 'out',
      type: 'cross-dissolve',
      requestedDurationFrames: 120,
      mediaAssets: media,
      fps: 24,
    });

    expect(limit.centeredOnCut).toBe(true);
    expect(limit.maxDurationFrames).toBe(60);
    expect(limit.clampedDurationFrames).toBe(60);
    expect(limit.neighborClipId).toBe('right');
    expect(limit.neighborSide).toBe('in');
  });

  it('falls back to clip duration when there is no adjacent cut clip', () => {
    const clip = createClip({ id: 'solo', durationFrames: 80 });
    const track = createTrack([clip]);
    const limit = computeTransitionSideLimit({
      track,
      clip,
      side: 'out',
      type: 'cross-dissolve',
      requestedDurationFrames: 120,
      mediaAssets: [createMedia('m1', 10)],
      fps: 24,
    });

    expect(limit.centeredOnCut).toBe(false);
    expect(limit.maxDurationFrames).toBe(80);
    expect(limit.clampedDurationFrames).toBe(80);
    expect(limit.neighborClipId).toBeNull();
  });

  it('uses clip duration limits for fade-black transitions', () => {
    const clip = createClip({ id: 'fade', durationFrames: 42 });
    const track = createTrack([clip]);
    const limit = computeTransitionSideLimit({
      track,
      clip,
      side: 'in',
      type: 'fade-black',
      requestedDurationFrames: 100,
      mediaAssets: [createMedia('m1', 10)],
      fps: 24,
    });

    expect(limit.centeredOnCut).toBe(false);
    expect(limit.maxDurationFrames).toBe(42);
    expect(limit.clampedDurationFrames).toBe(42);
  });
});
