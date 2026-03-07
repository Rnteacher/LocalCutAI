import { describe, expect, it } from 'vitest';

describe('export parity scenarios', () => {
  it('extracts segments with blend/generator/crossfade information consistent with preview plan', async () => {
    const mod = await import('./exportService.js');

    const seqRow = {
      id: 'seq-parity',
      projectId: 'proj1',
      name: 'Parity sequence',
      frameRateNum: 24,
      frameRateDen: 1,
      width: 1920,
      height: 1080,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;

    const seqData = {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          visible: true,
          muted: false,
          clips: [
            {
              id: 'vc1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 48,
              sourceInFrame: 0,
              sourceOutFrame: 48,
              blendMode: 'silhouette-luma',
              blendParams: { silhouetteGamma: 1.7 },
              transitionOut: {
                id: 'tr-v-out',
                type: 'cross-dissolve',
                durationFrames: 12,
                audioCrossfade: true,
              },
            },
            {
              id: 'vc2',
              type: 'video',
              mediaAssetId: null,
              startFrame: 48,
              durationFrames: 48,
              sourceInFrame: 0,
              sourceOutFrame: 48,
              generator: { kind: 'color-matte', color: '#224466' },
              transitionIn: {
                id: 'tr-v-in',
                type: 'cross-dissolve',
                durationFrames: 12,
                audioCrossfade: true,
              },
            },
          ],
        },
        {
          id: 'a1',
          type: 'audio',
          visible: true,
          muted: false,
          clips: [
            {
              id: 'ac1',
              mediaAssetId: 'm1',
              type: 'audio',
              startFrame: 0,
              durationFrames: 48,
              sourceInFrame: 0,
              sourceOutFrame: 48,
              transitionOut: {
                id: 'tr-a-out',
                type: 'cross-dissolve',
                durationFrames: 12,
                audioCrossfade: true,
              },
            },
            {
              id: 'ac2',
              mediaAssetId: 'm1',
              type: 'audio',
              startFrame: 48,
              durationFrames: 48,
              sourceInFrame: 48,
              sourceOutFrame: 96,
              transitionIn: {
                id: 'tr-a-in',
                type: 'cross-dissolve',
                durationFrames: 12,
                audioCrossfade: true,
              },
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const segments = mod.__test__.extractSegments(sequence);

    expect(segments.videoSegments.some((seg: any) => seg.clipId === 'vc1' && seg.blendMode === 'silhouette-luma')).toBe(true);
    expect(
      segments.videoSegments.some(
        (seg: any) => seg.clipId === 'vc1' && Math.abs((seg.silhouetteGamma ?? 0) - 1.7) < 0.0001,
      ),
    ).toBe(true);
    expect(
      segments.videoSegments.some(
        (seg: any) => seg.clipId === 'vc2' && seg.generator?.kind === 'color-matte',
      ),
    ).toBe(true);

    const clip1AudioGains = segments.audioSegments
      .filter((seg: any) => seg.clipId === 'ac1')
      .map((seg: any) => seg.gain);
    const clip2AudioGains = segments.audioSegments
      .filter((seg: any) => seg.clipId === 'ac2')
      .map((seg: any) => seg.gain);

    expect(clip1AudioGains.length).toBeGreaterThan(1);
    expect(clip2AudioGains.length).toBeGreaterThan(1);
    expect(Math.max(...clip1AudioGains) - Math.min(...clip1AudioGains)).toBeGreaterThan(0.05);
    expect(Math.max(...clip2AudioGains) - Math.min(...clip2AudioGains)).toBeGreaterThan(0.05);
  });
});
