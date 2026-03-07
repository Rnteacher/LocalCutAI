import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateSequenceMock } = vi.hoisted(() => ({
  updateSequenceMock: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  api: {
    sequences: {
      update: updateSequenceMock,
    },
  },
}));

import { useProjectStore } from './projectStore.js';
import type { ApiSequence } from '../lib/api.js';
import type { TimelineClipData } from './projectStore.js';

function makeBaseClip(id: string, startFrame: number, durationFrames: number): TimelineClipData {
  return {
    id,
    name: id.toUpperCase(),
    type: 'video',
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
    blendMode: 'normal',
    blendParams: { silhouetteGamma: 1 },
    keyframes: [],
    transitionIn: null,
    transitionOut: null,
    masks: [],
    generator: null,
  };
}

function makeSequence(): ApiSequence {
  return {
    id: 'seq1',
    projectId: 'proj1',
    name: 'Sequence',
    frameRate: { num: 24, den: 1 },
    resolution: { width: 1920, height: 1080 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    data: {
      tracks: [
        {
          id: 'v1',
          sequenceId: 'seq1',
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
          clips: [makeBaseClip('c1', 0, 24), makeBaseClip('c2', 24, 24)],
        },
      ],
    },
  };
}

function getVideoTrackClips(): TimelineClipData[] {
  const seq = useProjectStore.getState().sequences[0];
  const data = seq.data as {
    tracks: Array<{
      id: string;
      clips: TimelineClipData[];
    }>;
  };
  return data.tracks.find((t) => t.id === 'v1')?.clips ?? [];
}

describe('projectStore timeline integration', () => {
  beforeEach(() => {
    updateSequenceMock.mockReset();
    updateSequenceMock.mockImplementation(async (id: string, body: { data?: Record<string, unknown> }) => {
      const prev = useProjectStore.getState().sequences.find((s) => s.id === id) ?? makeSequence();
      return {
        ...prev,
        data: body.data ?? prev.data,
        updatedAt: '2026-01-02T00:00:00.000Z',
      };
    });

    useProjectStore.setState({
      projects: [],
      currentProject: null,
      mediaAssets: [],
      sequences: [makeSequence()],
      isLoading: false,
      error: null,
      _history: [],
      _future: [],
    });
  });

  it('links cross-dissolve transitions across adjacent clips and clears linked side', async () => {
    await useProjectStore.getState().setClipTransition('c1', 'out', {
      id: 'tr-1',
      type: 'cross-dissolve',
      durationFrames: 120,
      audioCrossfade: true,
    });

    let clips = getVideoTrackClips();
    const c1 = clips.find((c) => c.id === 'c1');
    const c2 = clips.find((c) => c.id === 'c2');

    expect(c1?.transitionOut?.type).toBe('cross-dissolve');
    expect(c2?.transitionIn?.type).toBe('cross-dissolve');
    expect(c1?.transitionOut?.durationFrames).toBe(c2?.transitionIn?.durationFrames);
    expect(c1?.transitionOut?.durationFrames ?? 0).toBeLessThanOrEqual(48);

    await useProjectStore.getState().setClipTransition('c1', 'out', null);

    clips = getVideoTrackClips();
    expect(clips.find((c) => c.id === 'c1')?.transitionOut).toBeNull();
    expect(clips.find((c) => c.id === 'c2')?.transitionIn).toBeNull();
  });

  it('adds overwrite generator clips with clip defaults and no overlap in insertion window', async () => {
    await useProjectStore.getState().addGeneratorClip({
      trackId: 'v1',
      generator: { kind: 'color-matte', color: '#112233' },
      name: 'Matte A',
      startFrame: 8,
      durationFrames: 10,
      insertMode: 'overwrite',
    });

    const clips = getVideoTrackClips();
    const matte = clips.find((clip) => clip.generator?.kind === 'color-matte');
    expect(matte).toBeDefined();
    expect(matte?.generator).toMatchObject({ kind: 'color-matte', color: '#112233' });
    expect(matte?.blendMode).toBe('normal');
    expect(matte?.keyframes).toEqual([]);
    expect(matte?.transitionIn).toBeNull();
    expect(matte?.transitionOut).toBeNull();

    const overlap = clips.some((clip) => {
      if (clip.id === matte?.id) return false;
      const start = clip.startFrame;
      const end = clip.startFrame + clip.durationFrames;
      return end > (matte?.startFrame ?? 0) && start < ((matte?.startFrame ?? 0) + (matte?.durationFrames ?? 0));
    });
    expect(overlap).toBe(false);
  });
});
