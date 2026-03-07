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

function makePoint(x: number, y: number) {
  return { x, y, inX: x, inY: y, outX: x, outY: y };
}

function makeSequence(): ApiSequence {
  return {
    id: 'seq1',
    projectId: 'proj1',
    name: 'Seq',
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
          clips: [
            {
              id: 'c1',
              name: 'Clip 1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              mediaAssetId: 'm1',
              masks: [
                {
                  id: 'm1',
                  name: 'Mask 1',
                  mode: 'add',
                  closed: true,
                  invert: false,
                  opacity: 1,
                  feather: 0,
                  expansion: 0,
                  keyframes: [
                    {
                      id: 'mkf1',
                      frame: 0,
                      points: [
                        makePoint(0.2, 0.2),
                        makePoint(0.8, 0.2),
                        makePoint(0.8, 0.8),
                        makePoint(0.2, 0.8),
                      ],
                    },
                    {
                      id: 'mkf2',
                      frame: 12,
                      points: [
                        makePoint(0.25, 0.2),
                        makePoint(0.85, 0.2),
                        makePoint(0.85, 0.8),
                        makePoint(0.25, 0.8),
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function getMaskKeyframesFromStore() {
  const seq = useProjectStore.getState().sequences[0];
  const data = seq.data as {
    tracks: Array<{
      clips: Array<{
        masks?: Array<{
          keyframes: Array<{ frame: number; points: Array<{ x: number; y: number }> }>;
        }>;
      }>;
    }>;
  };
  return data.tracks[0].clips[0].masks?.[0].keyframes ?? [];
}

describe('projectStore mask topology sync', () => {
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

  it('inserts a mask point across all keyframes at the same topology index', async () => {
    const inserted = makePoint(0.5, 0.35);
    await useProjectStore.getState().insertMaskPointAcrossKeyframes('c1', 'm1', {
      frame: 0,
      insertAt: 2,
      point: inserted,
    });

    const keyframes = getMaskKeyframesFromStore();
    expect(keyframes).toHaveLength(2);
    expect(keyframes[0].points).toHaveLength(5);
    expect(keyframes[1].points).toHaveLength(5);
    expect(keyframes[0].points[2]).toMatchObject({ x: 0.5, y: 0.35 });
    expect(keyframes[1].points[2].x).toBeCloseTo((0.85 + 0.85) / 2, 6);
    expect(keyframes[1].points[2].y).toBeCloseTo((0.2 + 0.8) / 2, 6);
  });

  it('removes the same mask point index across all keyframes', async () => {
    await useProjectStore.getState().removeMaskPointAcrossKeyframes('c1', 'm1', 1);

    const keyframes = getMaskKeyframesFromStore();
    expect(keyframes).toHaveLength(2);
    expect(keyframes[0].points).toHaveLength(3);
    expect(keyframes[1].points).toHaveLength(3);
    expect(keyframes[0].points[1].x).toBeCloseTo(0.8, 6);
    expect(keyframes[1].points[1].x).toBeCloseTo(0.85, 6);
  });
});
