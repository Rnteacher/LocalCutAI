import { describe, it, expect } from 'vitest';
import type { FrameRate, TimeValue } from '../types/project.js';
import type { Sequence, Track, ClipItem } from '../types/timeline.js';
import { buildCompositionPlan } from './compositionPlan.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FPS24: FrameRate = { num: 24, den: 1 };

function tv(frames: number): TimeValue {
  return { frames, rate: FPS24 };
}

function makeClip(
  overrides: Partial<ClipItem> & { id: string },
): ClipItem {
  return {
    trackId: 'T1',
    mediaAssetId: 'M1',
    type: 'video',
    name: 'Clip',
    startTime: tv(0),
    duration: tv(48),
    sourceInPoint: tv(0),
    sourceOutPoint: tv(48),
    volume: 1,
    pan: 0,
    audioEnvelope: [],
    transform: {
      positionX: 0, positionY: 0, scaleX: 1, scaleY: 1,
      rotation: 0, anchorX: 0, anchorY: 0,
    },
    opacity: 1,
    blendMode: 'normal' as const,
    keyframes: [],
    transitionIn: null,
    transitionOut: null,
    masks: [],
    disabled: false,
    ...overrides,
  };
}

function makeTrack(id: string, clips: ClipItem[], type: 'video' | 'audio' = 'video'): Track {
  return {
    id,
    sequenceId: 'SEQ1',
    name: id,
    type,
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

function makeSequence(tracks: Track[]): Sequence {
  return {
    id: 'SEQ1',
    projectId: 'P1',
    name: 'Test Seq',
    frameRate: FPS24,
    resolution: { width: 1920, height: 1080 },
    duration: tv(240),
    tracks,
    createdAt: '',
    updatedAt: '',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCompositionPlan', () => {
  it('returns empty layers when no clips overlap', () => {
    const clip = makeClip({ id: 'C1', startTime: tv(100), duration: tv(48) });
    const track = makeTrack('V1', [clip]);
    const seq = makeSequence([track]);

    const plan = buildCompositionPlan(seq, tv(0));
    expect(plan.videoLayers).toHaveLength(0);
    expect(plan.audioSources).toHaveLength(0);
  });

  it('includes video layer with correct properties', () => {
    const clip = makeClip({ id: 'C1', startTime: tv(0), duration: tv(48), opacity: 0.8 });
    const track = makeTrack('V1', [clip]);
    const seq = makeSequence([track]);

    const plan = buildCompositionPlan(seq, tv(12));
    expect(plan.videoLayers).toHaveLength(1);

    const layer = plan.videoLayers[0];
    expect(layer.clipId).toBe('C1');
    expect(layer.opacity).toBeCloseTo(0.8);
    expect(layer.blendMode).toBe('normal');
    expect(layer.transitionProgress).toBeNull();
  });

  it('orders video layers bottom-to-top', () => {
    // Tracks in sequence are top-to-bottom: V2, V1
    const clipV2 = makeClip({ id: 'CV2', startTime: tv(0), duration: tv(48) });
    const clipV1 = makeClip({ id: 'CV1', startTime: tv(0), duration: tv(48) });

    // V2 is listed first (topmost in UI), V1 second
    const seq = makeSequence([
      makeTrack('V2', [clipV2]),
      makeTrack('V1', [clipV1]),
    ]);

    const plan = buildCompositionPlan(seq, tv(12));
    expect(plan.videoLayers).toHaveLength(2);
    // Bottom-to-top: V1 first (bottom), V2 second (top)
    expect(plan.videoLayers[0].clipId).toBe('CV1');
    expect(plan.videoLayers[1].clipId).toBe('CV2');
  });

  it('includes audio sources for audio clips', () => {
    const aClip = makeClip({
      id: 'AC1', type: 'audio', startTime: tv(0), duration: tv(48),
    });
    const aTrack = makeTrack('A1', [aClip], 'audio');
    const seq = makeSequence([aTrack]);

    const plan = buildCompositionPlan(seq, tv(10));
    expect(plan.audioSources).toHaveLength(1);
    expect(plan.audioSources[0].clipId).toBe('AC1');
    expect(plan.audioSources[0].gain).toBeCloseTo(1.0);
  });

  it('video clips produce both video layers and audio sources', () => {
    const vClip = makeClip({ id: 'VC1', type: 'video', startTime: tv(0), duration: tv(48) });
    const vTrack = makeTrack('V1', [vClip], 'video');
    const seq = makeSequence([vTrack]);

    const plan = buildCompositionPlan(seq, tv(10));
    expect(plan.videoLayers).toHaveLength(1);
    expect(plan.audioSources).toHaveLength(1);
  });

  it('muted tracks produce no audio', () => {
    const aClip = makeClip({
      id: 'AC1', type: 'audio', startTime: tv(0), duration: tv(48),
    });
    const aTrack = makeTrack('A1', [aClip], 'audio');
    aTrack.muted = true;
    const seq = makeSequence([aTrack]);

    const plan = buildCompositionPlan(seq, tv(10));
    expect(plan.audioSources).toHaveLength(0);
  });

  it('resolves transition progress for transitionIn', () => {
    const clip = makeClip({
      id: 'C1',
      startTime: tv(0),
      duration: tv(48),
      transitionIn: {
        id: 'TR1',
        type: 'dissolve',
        duration: tv(12),
        params: {},
      },
    });
    const track = makeTrack('V1', [clip]);
    const seq = makeSequence([track]);

    // At frame 6 of a 12-frame transition, progress should be 0.5
    const plan = buildCompositionPlan(seq, tv(6));
    expect(plan.videoLayers[0].transitionProgress).toBeCloseTo(0.5);
    expect(plan.videoLayers[0].transitionType).toBe('dissolve');
  });

  it('no transition when past transitionIn duration', () => {
    const clip = makeClip({
      id: 'C1',
      startTime: tv(0),
      duration: tv(48),
      transitionIn: {
        id: 'TR1',
        type: 'dissolve',
        duration: tv(12),
        params: {},
      },
    });
    const track = makeTrack('V1', [clip]);
    const seq = makeSequence([track]);

    const plan = buildCompositionPlan(seq, tv(24));
    expect(plan.videoLayers[0].transitionProgress).toBeNull();
  });

  it('returns correct resolution and sequenceId', () => {
    const seq = makeSequence([]);
    const plan = buildCompositionPlan(seq, tv(0));
    expect(plan.sequenceId).toBe('SEQ1');
    expect(plan.resolution.width).toBe(1920);
    expect(plan.resolution.height).toBe(1080);
  });
});
