import type { FastifyPluginAsync } from 'fastify';
import { startExport, cancelExport } from '../services/exportService.js';
import type { ExportParams } from '../services/exportService.js';
import { getDb } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { eq } from 'drizzle-orm';

interface ExportBody {
  sequenceId: string;
  outputDir?: string;
  filename?: string;
  format?: 'mp4' | 'mov' | 'webm' | 'mkv';
  videoCodec?: 'libx264' | 'libx265' | 'libvpx-vp9' | 'copy';
  audioCodec?: 'aac' | 'libopus' | 'pcm_s16le' | 'copy';
  width?: number;
  height?: number;
  crf?: number;
  preset?:
    | 'ultrafast'
    | 'superfast'
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow'
    | 'slower'
    | 'veryslow';
  audioBitrate?: string;
  audioSampleRate?: number;
}

const VALID_FORMATS = new Set<ExportParams['format']>(['mp4', 'mov', 'webm', 'mkv']);
const VALID_VIDEO_CODECS = new Set<ExportParams['videoCodec']>([
  'libx264',
  'libx265',
  'libvpx-vp9',
  'copy',
]);
const VALID_AUDIO_CODECS = new Set<ExportParams['audioCodec']>([
  'aac',
  'libopus',
  'pcm_s16le',
  'copy',
]);
const VALID_PRESETS = new Set<NonNullable<ExportParams['preset']>>([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
]);

export const exportRoutes: FastifyPluginAsync = async (fastify) => {
  // POST / - Start an export job
  fastify.post<{ Body: ExportBody }>('/', async (request, reply) => {
    const body = request.body;

    if (!body?.sequenceId) {
      return reply.code(400).send({ success: false, error: 'sequenceId is required' });
    }

    if (body.format && !VALID_FORMATS.has(body.format)) {
      return reply.code(400).send({ success: false, error: 'Invalid format' });
    }
    if (body.videoCodec && !VALID_VIDEO_CODECS.has(body.videoCodec)) {
      return reply.code(400).send({ success: false, error: 'Invalid videoCodec' });
    }
    if (body.audioCodec && !VALID_AUDIO_CODECS.has(body.audioCodec)) {
      return reply.code(400).send({ success: false, error: 'Invalid audioCodec' });
    }
    if (body.preset && !VALID_PRESETS.has(body.preset)) {
      return reply.code(400).send({ success: false, error: 'Invalid preset' });
    }
    if (body.videoCodec === 'copy' || body.audioCodec === 'copy') {
      return reply.code(400).send({
        success: false,
        error: 'Codec copy is not supported for timeline exports. Choose explicit video/audio codecs.',
      });
    }

    if (body.filename && /[<>:"/\\|?*\u0000-\u001F]/.test(body.filename)) {
      return reply.code(400).send({ success: false, error: 'filename contains invalid characters' });
    }
    if (body.outputDir && body.outputDir.includes('\0')) {
      return reply.code(400).send({ success: false, error: 'outputDir contains invalid characters' });
    }

    if (body.width !== undefined && (!Number.isInteger(body.width) || body.width <= 0 || body.width > 16384)) {
      return reply.code(400).send({ success: false, error: 'width must be an integer between 1 and 16384' });
    }
    if (body.height !== undefined && (!Number.isInteger(body.height) || body.height <= 0 || body.height > 16384)) {
      return reply.code(400).send({ success: false, error: 'height must be an integer between 1 and 16384' });
    }
    if (body.crf !== undefined && (!Number.isFinite(body.crf) || body.crf < 0 || body.crf > 51)) {
      return reply.code(400).send({ success: false, error: 'crf must be between 0 and 51' });
    }
    if (
      body.audioSampleRate !== undefined &&
      (!Number.isInteger(body.audioSampleRate) || body.audioSampleRate < 8000 || body.audioSampleRate > 192000)
    ) {
      return reply
        .code(400)
        .send({ success: false, error: 'audioSampleRate must be an integer between 8000 and 192000' });
    }
    if (body.audioBitrate !== undefined && !/^\d+[kKmM]$/.test(body.audioBitrate)) {
      return reply.code(400).send({ success: false, error: 'audioBitrate must be like 128k or 1M' });
    }

    const params: ExportParams = {
      sequenceId: body.sequenceId,
      outputDir: body.outputDir,
      filename: body.filename,
      format: body.format || 'mp4',
      videoCodec: body.videoCodec || 'libx264',
      audioCodec: body.audioCodec || 'aac',
      width: body.width,
      height: body.height,
      crf: body.crf,
      preset: body.preset || 'medium',
      audioBitrate: body.audioBitrate || '192k',
      audioSampleRate: body.audioSampleRate || 48000,
    };

    // Progress callback that broadcasts via WebSocket (if available)
    const onProgress = (jobId: string, progress: number, status: string) => {
      // Broadcast to all connected WebSocket clients
      fastify.websocketServer?.clients?.forEach((client) => {
        if (client.readyState === 1) {
          client.send(
            JSON.stringify({
              type: 'job:progress',
              data: { jobId, progress, status },
            }),
          );
        }
      });
    };

    try {
      const job = await startExport(params, onProgress);
      return { success: true, data: job };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed';
      return reply.code(400).send({ success: false, error: message });
    }
  });

  // POST /:id/cancel - Cancel a running export
  fastify.post<{ Params: { id: string } }>('/:id/cancel', async (request, reply) => {
    const cancelled = cancelExport(request.params.id);
    if (!cancelled) {
      // Check if job exists but isn't running
      const db = getDb();
      const row = db.select().from(jobs).where(eq(jobs.id, request.params.id)).get();
      if (!row) {
        return reply.code(404).send({ success: false, error: 'Job not found' });
      }
      return reply.code(400).send({
        success: false,
        error: `Job is not currently running (status: ${row.status})`,
      });
    }
    return { success: true };
  });

  // GET /presets - Return available export presets
  fastify.get('/presets', async () => {
    return {
      success: true,
      data: [
        {
          name: 'H.264 High Quality',
          format: 'mp4',
          videoCodec: 'libx264',
          audioCodec: 'aac',
          crf: 18,
          preset: 'medium',
          audioBitrate: '192k',
          audioSampleRate: 48000,
        },
        {
          name: 'H.264 Fast (Draft)',
          format: 'mp4',
          videoCodec: 'libx264',
          audioCodec: 'aac',
          crf: 23,
          preset: 'veryfast',
          audioBitrate: '128k',
          audioSampleRate: 48000,
        },
        {
          name: 'H.265 High Quality',
          format: 'mp4',
          videoCodec: 'libx265',
          audioCodec: 'aac',
          crf: 22,
          preset: 'medium',
          audioBitrate: '192k',
          audioSampleRate: 48000,
        },
        {
          name: 'WebM VP9',
          format: 'webm',
          videoCodec: 'libvpx-vp9',
          audioCodec: 'libopus',
          crf: 30,
          preset: 'medium',
          audioBitrate: '128k',
          audioSampleRate: 48000,
        },
        {
          name: 'MOV Master (H.264 + PCM)',
          format: 'mov',
          videoCodec: 'libx264',
          audioCodec: 'pcm_s16le',
          audioBitrate: undefined,
          audioSampleRate: 48000,
        },
      ],
    };
  });
};
