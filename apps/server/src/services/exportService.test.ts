/**
 * Unit tests for the export service FFmpeg arg builder.
 *
 * These test the pure logic of building FFmpeg command-line arguments
 * without actually invoking FFmpeg or touching the database.
 */

import { describe, it, expect } from 'vitest';

// Re-export the internal helpers for testing by extracting logic
// Since the internal functions aren't exported, we test via the module's behavior.
// For now, test the helper functions directly by importing the module.

// We'll test the timeToSeconds and computeSequenceDuration logic
// by verifying the exported types and params flow.

describe('ExportService types', () => {
  it('should define ExportParams shape', async () => {
    const mod = await import('./exportService.js');
    expect(mod.startExport).toBeDefined();
    expect(typeof mod.startExport).toBe('function');
    expect(mod.cancelExport).toBeDefined();
    expect(typeof mod.cancelExport).toBe('function');
  });
});

describe('ExportService core-plan integration', () => {
  it('adapts legacy frame-based data to core sequence', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq1',
      projectId: 'proj1',
      name: 'Sequence 1',
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
          volume: 1,
          pan: 0,
          clips: [
            {
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              name: 'clip',
              startFrame: 10,
              durationFrames: 20,
              sourceInFrame: 5,
              positionX: 12,
              positionY: -8,
              scaleX: 1.2,
              scaleY: 0.9,
              rotation: 5,
              opacity: 0.8,
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    expect(sequence.frameRate.num).toBe(24);
    expect(sequence.duration.frames).toBe(30);
    expect(sequence.tracks[0].clips[0].startTime.frames).toBe(10);
    expect(sequence.tracks[0].clips[0].sourceInPoint.frames).toBe(5);
    expect(sequence.tracks[0].clips[0].transform.positionX).toBe(12);
    expect(sequence.tracks[0].clips[0].opacity).toBe(0.8);
  });

  it('adapts modern audio fields for export gain/pan', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-modern-audio',
      projectId: 'proj1',
      name: 'Sequence modern audio',
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
          id: 'a1',
          type: 'audio',
          visible: true,
          muted: false,
          volume: 1,
          pan: 0,
          clips: [
            {
              id: 'ac1',
              mediaAssetId: 'm1',
              type: 'audio',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              audioGainDb: -6,
              audioPan: 0.25,
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const clip = sequence.tracks[0].clips[0];

    expect(clip.volume).toBeCloseTo(0.501, 3);
    expect(clip.pan).toBe(0.25);
  });

  it('extracts composition segments and includes transform continuity keys', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq2',
      projectId: 'proj1',
      name: 'Sequence 2',
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
          volume: 1,
          pan: 0,
          clips: [
            {
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              opacity: 1,
              positionX: 20,
              positionY: 10,
              scaleX: 1,
              scaleY: 1,
              rotation: 0,
            },
          ],
        },
        {
          id: 'a1',
          type: 'audio',
          visible: true,
          muted: false,
          volume: 1,
          pan: 0,
          clips: [
            {
              id: 'ac1',
              mediaAssetId: 'm1',
              type: 'audio',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              volume: 0.5,
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const segments = mod.__test__.extractSegments(sequence);

    expect(segments.videoSegments.length).toBeGreaterThan(0);
    expect(segments.audioSegments.length).toBeGreaterThan(0);
    expect(segments.videoSegments[0].positionX).toBe(20);
    expect(segments.videoSegments[0].positionY).toBe(10);
  });

  it('keeps animated mask segments split across frames', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-mask-split',
      projectId: 'proj1',
      name: 'Sequence mask split',
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
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 12,
              masks: [
                {
                  id: 'm1',
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
                        { x: 0.2, y: 0.2 },
                        { x: 0.8, y: 0.2 },
                        { x: 0.8, y: 0.8 },
                        { x: 0.2, y: 0.8 },
                      ],
                    },
                    {
                      id: 'mkf2',
                      frame: 11,
                      points: [
                        { x: 0.25, y: 0.2 },
                        { x: 0.85, y: 0.2 },
                        { x: 0.85, y: 0.8 },
                        { x: 0.25, y: 0.8 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const segments = mod.__test__.extractSegments(sequence);
    expect(segments.videoSegments.length).toBeGreaterThan(1);
    expect(segments.videoSegments.some((s: any) => s.clipLocalStartFrame > 0)).toBe(true);
  });

  it('does not split video segments per-frame when clip keyframes are static', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-static-kf',
      projectId: 'proj1',
      name: 'Sequence static kf',
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
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              keyframes: [
                { id: 'k1', property: 'opacity', frame: 0, value: 0.7 },
                { id: 'k2', property: 'opacity', frame: 23, value: 0.7 },
              ],
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const segments = mod.__test__.extractSegments(sequence);
    expect(segments.videoSegments.length).toBe(1);
  });

  it('does not split video segments per-frame when mask shape keyframes are static', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-static-mask',
      projectId: 'proj1',
      name: 'Sequence static mask',
      frameRateNum: 24,
      frameRateDen: 1,
      width: 1920,
      height: 1080,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;

    const square = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ];

    const seqData = {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          visible: true,
          muted: false,
          clips: [
            {
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              masks: [
                {
                  id: 'm1',
                  mode: 'add',
                  closed: true,
                  invert: false,
                  opacity: 1,
                  feather: 0,
                  expansion: 0,
                  keyframes: [
                    { id: 'mk1', frame: 0, points: square },
                    { id: 'mk2', frame: 23, points: square },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const segments = mod.__test__.extractSegments(sequence);
    expect(segments.videoSegments.length).toBe(1);
  });

  it('builds ffmpeg args with transform filters', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq3',
      projectId: 'proj1',
      name: 'Sequence 3',
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
          volume: 1,
          pan: 0,
          clips: [
            {
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              positionX: 30,
              positionY: -12,
              scaleX: 1.1,
              scaleY: 0.8,
              rotation: 12,
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const args = mod.__test__.buildFFmpegArgs(
      sequence,
      {
        sequenceId: sequence.id,
        format: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
        preset: 'medium',
      },
      'out.mp4',
      new Map([['m1', 'media.mp4']]),
      1,
    );

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('rotate=');
    expect(filterArg).toContain("overlay=x='");
    expect(filterArg).toContain('scale=iw*1.100000:ih*0.800000');
  });

  it('builds ffmpeg args with clip color and mono channel routing', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq4',
      projectId: 'proj1',
      name: 'Sequence 4',
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
          volume: 1,
          pan: 0,
          clips: [
            {
              id: 'vc1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              brightness: 1.2,
              contrast: 0.9,
              saturation: 1.1,
              hue: 15,
              vignette: 0.35,
            },
          ],
        },
        {
          id: 'a1',
          type: 'audio',
          visible: true,
          muted: false,
          volume: 1,
          pan: 0,
          channelMode: 'mono',
          channelMap: 'L',
          clips: [
            {
              id: 'ac1',
              mediaAssetId: 'm1',
              type: 'audio',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              audioGainDb: -3,
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const args = mod.__test__.buildFFmpegArgs(
      sequence,
      {
        sequenceId: sequence.id,
        format: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
      },
      'out.mp4',
      new Map([['m1', 'media.mp4']]),
      1,
      mod.__test__.buildStoredExportMeta(seqData as any),
    );

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain("lutrgb=r='clip(val*1.200000,0,255)'");
    expect(filterArg).toContain('eq=contrast=0.900000');
    expect(filterArg).toContain('hue=s=1.100000:h=15.000000');
    expect(filterArg).toContain('vignette=angle=');
    expect(filterArg).toContain('aformat=channel_layouts=stereo');
    expect(filterArg).toContain('pan=stereo|c0=');
    expect(filterArg).toContain('(c0)');
  });
});


describe('ExportService hardening', () => {
  it('sanitizes invalid filename characters', async () => {
    const mod = await import('./exportService.js');
    const sanitized = mod.__test__.sanitizeFilename('bad<>:"name?.mp4', 'fallback.mp4');
    expect(sanitized).toBe('bad____name_.mp4');
  });

  it('keeps default output under project exports directory', async () => {
    const mod = await import('./exportService.js');
    const out = mod.__test__.resolveOutputDir('D:/work/project');
    expect(out.replace(/\\/g, '/')).toBe('D:/work/project/exports');
  });

  it('rejects outputDir traversal outside project', async () => {
    const mod = await import('./exportService.js');
    expect(() => mod.__test__.resolveOutputDir('D:/work/project', '../escape')).toThrow(
      'outputDir must stay inside the project directory',
    );
  });

  it('rejects codec copy for filtered timeline exports', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-copy-guard',
      projectId: 'proj1',
      name: 'Sequence copy guard',
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
          volume: 1,
          pan: 0,
          clips: [
            {
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    expect(() =>
      mod.__test__.buildFFmpegArgs(
        sequence,
        {
          sequenceId: sequence.id,
          format: 'mov',
          videoCodec: 'copy',
          audioCodec: 'aac',
        },
        'out.mov',
        new Map([['m1', 'media.mp4']]),
        1,
      ),
    ).toThrow('Codec copy is not supported for timeline exports that require filtering.');
  });
});

describe('ExportService new timeline model support', () => {
  it('maps legacy dissolve transition to cross-dissolve and preserves keyframes', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-new-model',
      projectId: 'proj1',
      name: 'Sequence model',
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
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 48,
              sourceInFrame: 0,
              transitionIn: { id: 'tr1', type: 'dissolve', durationFrames: 12 },
              keyframes: [
                { id: 'k1', property: 'transform.positionX', frame: 0, value: 0, easing: 'linear' },
                { id: 'k2', property: 'transform.positionX', frame: 12, value: 200, easing: 'linear' },
              ],
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const clip = sequence.tracks[0].clips[0];
    expect(clip.transitionIn?.type).toBe('cross-dissolve');
    expect(clip.keyframes.length).toBe(2);
    expect(clip.keyframes[1].time.frames).toBe(12);
  });

  it('builds ffmpeg args for color matte generator segments', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-generator',
      projectId: 'proj1',
      name: 'Sequence generator',
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
              id: 'g1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              generator: { kind: 'color-matte', color: '#ff0000' },
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const args = mod.__test__.buildFFmpegArgs(
      sequence,
      {
        sequenceId: sequence.id,
        format: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
      },
      'out.mp4',
      new Map(),
      1,
    );

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('color=c=0xff0000');
  });

  it('builds ffmpeg args for silhouette-alpha blend mode', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-sil-alpha',
      projectId: 'proj1',
      name: 'Sequence silhouette alpha',
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
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              blendMode: 'silhouette-alpha',
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const args = mod.__test__.buildFFmpegArgs(
      sequence,
      {
        sequenceId: sequence.id,
        format: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
      },
      'out.mp4',
      new Map([['m1', 'media.mp4']]),
      1,
    );

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('alphaextract');
    expect(filterArg).toContain('alphamerge');
  });

  it('builds ffmpeg args for silhouette-luma blend mode with gamma', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-sil-luma',
      projectId: 'proj1',
      name: 'Sequence silhouette luma',
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
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              blendMode: 'silhouette-luma',
              blendParams: { silhouetteGamma: 1.75 },
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const args = mod.__test__.buildFFmpegArgs(
      sequence,
      {
        sequenceId: sequence.id,
        format: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
      },
      'out.mp4',
      new Map([['m1', 'media.mp4']]),
      1,
    );

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain("format=gray,lut=y='pow(val/255");
    expect(filterArg).toContain('alphamerge');
  });

  it('builds ffmpeg args for adjustment-layer generator segments', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-adjustment',
      projectId: 'proj1',
      name: 'Sequence adjustment',
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
          id: 'v2',
          type: 'video',
          visible: true,
          muted: false,
          clips: [
            {
              id: 'adj1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              generator: { kind: 'adjustment-layer' },
              brightness: 1.2,
              contrast: 1.1,
            },
          ],
        },
        {
          id: 'v1',
          type: 'video',
          visible: true,
          muted: false,
          clips: [
            {
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const args = mod.__test__.buildFFmpegArgs(
      sequence,
      {
        sequenceId: sequence.id,
        format: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
      },
      'out.mp4',
      new Map([['m1', 'media.mp4']]),
      1,
      mod.__test__.buildStoredExportMeta(seqData as any),
    );

    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('split[adjsrc');
    expect(filterArg).toContain("overlay=x='");
  });

  it('builds ffmpeg args when manual masks are present on exported clips', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-masks',
      projectId: 'proj1',
      name: 'Sequence masks',
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
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              masks: [
                {
                  id: 'm1',
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
                        { x: 0.2, y: 0.2 },
                        { x: 0.8, y: 0.2 },
                        { x: 0.8, y: 0.8 },
                        { x: 0.2, y: 0.8 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const args = mod.__test__.buildFFmpegArgs(
      sequence,
      {
        sequenceId: sequence.id,
        format: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
      },
      'out.mp4',
      new Map([['m1', 'media.mp4']]),
      1,
    );
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('geq=lum=');
    expect(filterArg).toContain('alphaextract');
    expect(filterArg).toContain('alphamerge');
  });

  it('adds black overlay video segments for fade-black transitions', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-fade-black',
      projectId: 'proj1',
      name: 'Sequence fade black',
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
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              transitionOut: {
                id: 'fo1',
                type: 'fade-black',
                durationFrames: 12,
              },
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const segments = mod.__test__.extractSegments(sequence);
    const fadeBlackSegments = segments.videoSegments.filter(
      (seg: any) =>
        seg.clipId === 'c1' &&
        seg.mediaAssetId == null &&
        seg.generator?.kind === 'black-video' &&
        seg.opacity > 0,
    );

    expect(fadeBlackSegments.length).toBeGreaterThan(0);
  });

  it('extracts centered dissolve audio segments with equal-power gains around cut', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-centered-audio',
      projectId: 'proj1',
      name: 'Sequence centered audio',
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
              id: 'out',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              transitionOut: {
                id: 'tout',
                type: 'cross-dissolve',
                durationFrames: 12,
                audioCrossfade: true,
              },
            },
            {
              id: 'in',
              mediaAssetId: 'm2',
              type: 'video',
              startFrame: 24,
              durationFrames: 24,
              sourceInFrame: 0,
              transitionIn: {
                id: 'tin',
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

    const midFrame = 24;
    const outMid = segments.audioSegments.find(
      (seg: any) => seg.clipId === 'out' && seg.startFrame <= midFrame && seg.endFrame > midFrame,
    );
    const inMid = segments.audioSegments.find(
      (seg: any) => seg.clipId === 'in' && seg.startFrame <= midFrame && seg.endFrame > midFrame,
    );

    expect(outMid).toBeTruthy();
    expect(inMid).toBeTruthy();
    expect(outMid!.gain).toBeCloseTo(Math.cos(Math.PI / 4), 3);
    expect(inMid!.gain).toBeCloseTo(Math.sin(Math.PI / 4), 3);
  });
});

describe('ExportService preview/export parity (segment sampling)', () => {
  it('matches centered cross-dissolve video opacity and audio equal-power at sampled frames', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-parity-dissolve',
      projectId: 'proj1',
      name: 'Sequence parity dissolve',
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
              id: 'out',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              transitionOut: {
                id: 'tout',
                type: 'cross-dissolve',
                durationFrames: 12,
                audioCrossfade: true,
              },
            },
            {
              id: 'in',
              mediaAssetId: 'm2',
              type: 'video',
              startFrame: 24,
              durationFrames: 24,
              sourceInFrame: 0,
              transitionIn: {
                id: 'tin',
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
    const { videoSegments, audioSegments } = mod.__test__.extractSegments(sequence);

    const sampleSegment = <T extends { clipId: string; startFrame: number; endFrame: number }>(
      segments: T[],
      clipId: string,
      frame: number,
    ): T | null =>
      segments.find((s) => s.clipId === clipId && s.startFrame <= frame && s.endFrame > frame) ?? null;

    const sampledFrames = [19, 24, 29]; // within centered dissolve window [18, 30)
    for (const frame of sampledFrames) {
      const progress = (frame - 18) / 12;
      const expectedOutOpacity = 1 - progress;
      const expectedInOpacity = progress;
      const expectedOutGain = Math.cos((progress * Math.PI) / 2);
      const expectedInGain = Math.sin((progress * Math.PI) / 2);

      const outVideo = sampleSegment(videoSegments, 'out', frame);
      const inVideo = sampleSegment(videoSegments, 'in', frame);
      const outAudio = sampleSegment(audioSegments, 'out', frame);
      const inAudio = sampleSegment(audioSegments, 'in', frame);

      expect(outVideo).toBeTruthy();
      expect(inVideo).toBeTruthy();
      expect(outAudio).toBeTruthy();
      expect(inAudio).toBeTruthy();

      expect(outVideo!.opacity).toBeCloseTo(expectedOutOpacity, 3);
      expect(inVideo!.opacity).toBeCloseTo(expectedInOpacity, 3);
      expect(outAudio!.gain).toBeCloseTo(expectedOutGain, 3);
      expect(inAudio!.gain).toBeCloseTo(expectedInGain, 3);
    }
  });

  it('matches fade-black preview semantics via black overlay segment at sampled frames', async () => {
    const mod = await import('./exportService.js');
    const seqRow = {
      id: 'seq-parity-fade-black',
      projectId: 'proj1',
      name: 'Sequence parity fade black',
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
              id: 'c1',
              mediaAssetId: 'm1',
              type: 'video',
              startFrame: 0,
              durationFrames: 24,
              sourceInFrame: 0,
              transitionOut: {
                id: 'fb1',
                type: 'fade-black',
                durationFrames: 12,
              },
            },
          ],
        },
      ],
    };

    const sequence = mod.__test__.adaptStoredSequenceToCore(seqRow, seqData as any);
    const { videoSegments } = mod.__test__.extractSegments(sequence);

    const sampleContent = (frame: number) =>
      videoSegments.find(
        (s: any) =>
          s.clipId === 'c1' &&
          s.mediaAssetId === 'm1' &&
          s.startFrame <= frame &&
          s.endFrame > frame,
      ) ?? null;

    const sampleBlackOverlay = (frame: number) =>
      videoSegments.find(
        (s: any) =>
          s.clipId === 'c1' &&
          s.mediaAssetId == null &&
          s.generator?.kind === 'black-video' &&
          s.startFrame <= frame &&
          s.endFrame > frame,
      ) ?? null;

    const sampledFrames = [13, 18, 23]; // within out-transition window [12, 24)
    for (const frame of sampledFrames) {
      const progress = (frame - 12) / 12;
      const expectedContent = 1 - progress;
      const expectedBlack = progress;

      const content = sampleContent(frame);
      const black = sampleBlackOverlay(frame);
      expect(content).toBeTruthy();
      expect(black).toBeTruthy();

      expect(content!.opacity).toBeCloseTo(expectedContent, 3);
      expect(black!.opacity).toBeCloseTo(expectedBlack, 3);
      expect(content!.opacity + black!.opacity).toBeCloseTo(1, 3);
    }
  });
});
describe('TimeValue to seconds conversion', () => {
  // Test the inline timeToSeconds logic by computing expected values
  function timeToSeconds(tv: { frames: number; rate: { num: number; den: number } }): number {
    if (!tv || !tv.rate || tv.rate.num === 0) return 0;
    const fps = tv.rate.num / tv.rate.den;
    return tv.frames / fps;
  }

  it('should convert 24fps frames to seconds', () => {
    expect(timeToSeconds({ frames: 24, rate: { num: 24, den: 1 } })).toBe(1);
    expect(timeToSeconds({ frames: 48, rate: { num: 24, den: 1 } })).toBe(2);
    expect(timeToSeconds({ frames: 12, rate: { num: 24, den: 1 } })).toBe(0.5);
  });

  it('should convert 30fps frames to seconds', () => {
    expect(timeToSeconds({ frames: 30, rate: { num: 30, den: 1 } })).toBe(1);
    expect(timeToSeconds({ frames: 60, rate: { num: 30, den: 1 } })).toBe(2);
  });

  it('should convert 23.976fps (24000/1001) frames to seconds', () => {
    const result = timeToSeconds({ frames: 24, rate: { num: 24000, den: 1001 } });
    expect(result).toBeCloseTo(1.001, 3); // ~1.001 seconds
  });

  it('should handle zero rate', () => {
    expect(timeToSeconds({ frames: 100, rate: { num: 0, den: 1 } })).toBe(0);
  });

  it('should handle zero frames', () => {
    expect(timeToSeconds({ frames: 0, rate: { num: 24, den: 1 } })).toBe(0);
  });
});

describe('Sequence duration computation', () => {
  interface ClipData {
    startTime: { frames: number; rate: { num: number; den: number } };
    duration: { frames: number; rate: { num: number; den: number } };
    disabled: boolean;
  }

  interface TrackData {
    clips: ClipData[];
  }

  function computeSequenceDuration(tracks: TrackData[]): number {
    let maxEndTime = 0;
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.disabled) continue;
        const fps = clip.startTime.rate.num / clip.startTime.rate.den;
        const clipStart = clip.startTime.frames / fps;
        const clipDur = clip.duration.frames / fps;
        const clipEnd = clipStart + clipDur;
        if (clipEnd > maxEndTime) maxEndTime = clipEnd;
      }
    }
    return maxEndTime;
  }

  const rate24 = { num: 24, den: 1 };

  it('should compute duration from single clip', () => {
    const result = computeSequenceDuration([
      {
        clips: [
          {
            startTime: { frames: 0, rate: rate24 },
            duration: { frames: 48, rate: rate24 },
            disabled: false,
          },
        ],
      },
    ]);
    expect(result).toBe(2);
  });

  it('should pick the latest clip end', () => {
    const result = computeSequenceDuration([
      {
        clips: [
          {
            startTime: { frames: 0, rate: rate24 },
            duration: { frames: 24, rate: rate24 },
            disabled: false,
          },
          {
            startTime: { frames: 48, rate: rate24 },
            duration: { frames: 24, rate: rate24 },
            disabled: false,
          },
        ],
      },
    ]);
    expect(result).toBe(3); // 48+24=72 frames = 3 seconds
  });

  it('should skip disabled clips', () => {
    const result = computeSequenceDuration([
      {
        clips: [
          {
            startTime: { frames: 0, rate: rate24 },
            duration: { frames: 24, rate: rate24 },
            disabled: false,
          },
          {
            startTime: { frames: 240, rate: rate24 },
            duration: { frames: 24, rate: rate24 },
            disabled: true,
          },
        ],
      },
    ]);
    expect(result).toBe(1); // Only the first clip counts
  });

  it('should handle multiple tracks', () => {
    const result = computeSequenceDuration([
      {
        clips: [
          {
            startTime: { frames: 0, rate: rate24 },
            duration: { frames: 24, rate: rate24 },
            disabled: false,
          },
        ],
      },
      {
        clips: [
          {
            startTime: { frames: 0, rate: rate24 },
            duration: { frames: 120, rate: rate24 },
            disabled: false,
          },
        ],
      },
    ]);
    expect(result).toBe(5); // 120 frames = 5 seconds
  });

  it('should return 0 for empty tracks', () => {
    expect(computeSequenceDuration([])).toBe(0);
    expect(computeSequenceDuration([{ clips: [] }])).toBe(0);
  });
});
