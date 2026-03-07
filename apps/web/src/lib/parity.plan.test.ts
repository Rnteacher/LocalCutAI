import { describe, expect, it } from 'vitest';
import { adaptSequence } from './timelineAdapter.js';
import { buildCompositionPlan } from './core.js';
import type { TimelineTrackData } from '../stores/projectStore.js';

function makeVisualClip(id: string, startFrame: number, durationFrames: number) {
  return {
    id,
    name: id,
    type: 'video' as const,
    startFrame,
    durationFrames,
    mediaAssetId: null,
    sourceInFrame: 0,
    sourceOutFrame: durationFrames,
    opacity: 1,
    positionX: 0,
    positionY: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    brightness: 1,
    contrast: 1,
    saturation: 1,
    hue: 0,
    vignette: 0,
    blendMode: 'normal' as const,
    blendParams: { silhouetteGamma: 1 },
    keyframes: [],
    transitionIn: null,
    transitionOut: null,
    masks: [],
    generator: null,
  };
}

describe('timeline adapter parity', () => {
  it('keeps blending/generator/transition data all the way into composition plan', () => {
    const clipA = {
      ...makeVisualClip('clip-a', 0, 48),
      blendMode: 'silhouette-luma' as const,
      blendParams: { silhouetteGamma: 1.7 },
      transitionOut: {
        id: 'tr-a',
        type: 'dissolve' as const,
        durationFrames: 12,
        audioCrossfade: true,
      },
    };

    const clipB = {
      ...makeVisualClip('clip-b', 48, 48),
      generator: { kind: 'color-matte' as const, color: '#224466' },
      transitionIn: {
        id: 'tr-b',
        type: 'cross-dissolve' as const,
        durationFrames: 12,
        audioCrossfade: true,
      },
    };

    const audioA = {
      ...makeVisualClip('audio-a', 0, 48),
      type: 'audio' as const,
      transitionOut: {
        id: 'atr-a',
        type: 'cross-dissolve' as const,
        durationFrames: 12,
        audioCrossfade: true,
      },
    };

    const audioB = {
      ...makeVisualClip('audio-b', 48, 48),
      type: 'audio' as const,
      transitionIn: {
        id: 'atr-b',
        type: 'cross-dissolve' as const,
        durationFrames: 12,
        audioCrossfade: true,
      },
    };

    const tracks = [
      {
        id: 'v1',
        sequenceId: 'seq-1',
        name: 'V1',
        type: 'video',
        index: 0,
        locked: false,
        syncLocked: true,
        visible: true,
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        channelMode: 'stereo',
        channelMap: 'L+R',
        clips: [clipA, clipB],
      },
      {
        id: 'a1',
        sequenceId: 'seq-1',
        name: 'A1',
        type: 'audio',
        index: 1,
        locked: false,
        syncLocked: true,
        visible: true,
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        channelMode: 'stereo',
        channelMap: 'L+R',
        clips: [audioA, audioB],
      },
    ] as unknown as TimelineTrackData[];

    const coreSequence = adaptSequence(
      'seq-1',
      'proj-1',
      'Parity Sequence',
      tracks,
      { num: 24, den: 1 },
      { width: 1920, height: 1080 },
    );

    const adaptedClipA = coreSequence.tracks[0].clips[0];
    expect(adaptedClipA.blendMode).toBe('silhouette-luma');
    expect(adaptedClipA.blendParams?.silhouetteGamma).toBeCloseTo(1.7, 6);
    expect(adaptedClipA.transitionOut?.type).toBe('cross-dissolve');

    const planAtCut = buildCompositionPlan(coreSequence, {
      frames: 48,
      rate: coreSequence.frameRate,
    });

    expect(planAtCut.videoLayers.some((layer) => layer.generator?.kind === 'color-matte')).toBe(true);
    expect(planAtCut.videoLayers.some((layer) => layer.transitionType === 'cross-dissolve')).toBe(true);
    expect(planAtCut.audioSources.some((source) => source.transitionAudioCrossfade)).toBe(true);
  });
});
