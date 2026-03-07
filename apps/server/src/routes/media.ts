import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../db/client.js';
import { mediaAssets, projects } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { probeFile, getMediaType } from '../util/ffprobe.js';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

const projectIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
  },
} as const;

const mediaAssetParamsSchema = {
  type: 'object',
  required: ['id', 'assetId'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    assetId: { type: 'string', minLength: 1 },
  },
} as const;

const importMediaBodySchema = {
  type: 'object',
  required: ['filePaths'],
  additionalProperties: false,
  properties: {
    filePaths: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: { type: 'string', minLength: 1 },
    },
  },
} as const;

const waveformParamsSchema = {
  type: 'object',
  required: ['assetId'],
  additionalProperties: false,
  properties: {
    assetId: { type: 'string', minLength: 1 },
  },
} as const;

const waveformQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    samples: { type: 'string', pattern: '^[0-9]{1,5}$' },
  },
} as const;

const mediaFileParamsSchema = {
  type: 'object',
  required: ['assetId'],
  additionalProperties: false,
  properties: {
    assetId: { type: 'string', minLength: 1 },
  },
} as const;

export const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /projects/:id/media/import - Import media by file path(s)
  fastify.post<{
    Params: { id: string };
    Body: { filePaths: string[] };
  }>(
    '/projects/:id/media/import',
    {
      schema: {
        params: projectIdParamsSchema,
        body: importMediaBodySchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const project = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!project) {
        return reply.code(404).send({ success: false, error: 'Project not found' });
      }

      const filePaths = request.body?.filePaths;
      if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
        return reply.code(400).send({ success: false, error: 'filePaths array is required' });
      }

      const imported: unknown[] = [];
      const errors: { path: string; error: string }[] = [];

      for (const filePath of filePaths) {
        try {
          // Verify file exists
          if (!fs.existsSync(filePath)) {
            errors.push({ path: filePath, error: 'File not found' });
            continue;
          }

          const stat = fs.statSync(filePath);
          const type = getMediaType(filePath);
          const probe = await probeFile(filePath);
          const id = nanoid(12);
          const now = new Date().toISOString();

          db.insert(mediaAssets)
            .values({
              id,
              projectId: request.params.id,
              name: path.basename(filePath),
              type,
              filePath,
              mimeType: probe.mimeType,
              fileSize: stat.size,
              duration: probe.duration,
              frameRateNum: probe.frameRateNum,
              frameRateDen: probe.frameRateDen,
              width: probe.width,
              height: probe.height,
              audioChannels: probe.audioChannels,
              audioSampleRate: probe.audioSampleRate,
              codec: probe.codec,
              importedAt: now,
              metadata: JSON.stringify({}),
            })
            .run();

          const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
          imported.push(mapMediaRow(row!));
        } catch (err) {
          errors.push({
            path: filePath,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      return {
        success: true,
        data: { imported, errors },
      };
    },
  );

  // POST /projects/:id/media/upload - Upload media files (multipart form-data)
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/media/upload',
    {
      schema: {
        params: projectIdParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const project = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!project) {
        return reply.code(404).send({ success: false, error: 'Project not found' });
      }

      // Ensure project media directory exists
      const mediaDir = path.join(project.projectDir, 'media');
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
      }

      const imported: unknown[] = [];
      const errors: { name: string; error: string }[] = [];

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type !== 'file') continue;

        const originalName = part.filename;
        if (!originalName) continue;

        // Generate unique filename to avoid collisions
        const ext = path.extname(originalName);
        const baseName = path.basename(originalName, ext);
        const uniqueName = `${baseName}_${nanoid(6)}${ext}`;
        const destPath = path.join(mediaDir, uniqueName);

        try {
          // Stream file to disk
          const writeStream = fs.createWriteStream(destPath);
          await pipeline(part.file, writeStream);

          // Check if file was truncated (exceeded size limit)
          if (part.file.truncated) {
            fs.unlinkSync(destPath);
            errors.push({ name: originalName, error: 'File too large (max 10 GB)' });
            continue;
          }

          const stat = fs.statSync(destPath);
          const type = getMediaType(destPath);
          const probe = await probeFile(destPath);
          const id = nanoid(12);
          const now = new Date().toISOString();

          db.insert(mediaAssets)
            .values({
              id,
              projectId: request.params.id,
              name: originalName,
              type,
              filePath: destPath,
              mimeType: probe.mimeType,
              fileSize: stat.size,
              duration: probe.duration,
              frameRateNum: probe.frameRateNum,
              frameRateDen: probe.frameRateDen,
              width: probe.width,
              height: probe.height,
              audioChannels: probe.audioChannels,
              audioSampleRate: probe.audioSampleRate,
              codec: probe.codec,
              importedAt: now,
              metadata: JSON.stringify({}),
            })
            .run();

          const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
          imported.push(mapMediaRow(row!));
        } catch (err) {
          // Clean up partial file on error
          if (fs.existsSync(destPath)) {
            try {
              fs.unlinkSync(destPath);
            } catch {
              // ignore cleanup error
            }
          }
          errors.push({
            name: originalName,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      return { success: true, data: { imported, errors } };
    },
  );

  // GET /projects/:id/media - List media assets for a project
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/media',
    {
      schema: {
        params: projectIdParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const project = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!project) {
        return reply.code(404).send({ success: false, error: 'Project not found' });
      }

      const rows = db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.projectId, request.params.id))
        .all();

      return {
        success: true,
        data: rows.map(mapMediaRow),
        total: rows.length,
        offset: 0,
        limit: 100,
      };
    },
  );

  // GET /projects/:id/media/:assetId - Get a single media asset
  fastify.get<{ Params: { id: string; assetId: string } }>(
    '/projects/:id/media/:assetId',
    {
      schema: {
        params: mediaAssetParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const row = db
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.id, request.params.assetId),
            eq(mediaAssets.projectId, request.params.id),
          ),
        )
        .get();

      if (!row) {
        return reply.code(404).send({ success: false, error: 'Media asset not found' });
      }

      return { success: true, data: mapMediaRow(row) };
    },
  );

  // DELETE /projects/:id/media/:assetId - Remove media from project
  fastify.delete<{ Params: { id: string; assetId: string } }>(
    '/projects/:id/media/:assetId',
    {
      schema: {
        params: mediaAssetParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const row = db
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.id, request.params.assetId),
            eq(mediaAssets.projectId, request.params.id),
          ),
        )
        .get();

      if (!row) {
        return reply.code(404).send({ success: false, error: 'Media asset not found' });
      }

      db.delete(mediaAssets).where(eq(mediaAssets.id, request.params.assetId)).run();
      return { success: true };
    },
  );

  // GET /media-file/:assetId/waveform - Generate waveform peak data via FFmpeg
  // Returns JSON array of peak amplitudes (0-1) at ~800 sample resolution.
  fastify.get<{ Params: { assetId: string }; Querystring: { samples?: string } }>(
    '/media-file/:assetId/waveform',
    {
      schema: {
        params: waveformParamsSchema,
        querystring: waveformQuerySchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, request.params.assetId)).get();
      if (!row) {
        return reply.code(404).send({ error: 'Media not found' });
      }
      if (!fs.existsSync(row.filePath)) {
        return reply.code(404).send({ error: 'File not found on disk' });
      }

      const numSamples = Math.min(4000, Math.max(100, parseInt(request.query.samples || '800', 10)));

      try {
        // Extract audio as raw f32le samples at a low sample rate
        // Use a sample rate that gives us roughly numSamples total samples
        const duration = row.duration ?? 10;
        const sampleRate = Math.max(100, Math.ceil(numSamples / duration));

        const { stdout } = await execFileAsync(
          config.ffmpeg.ffmpegPath,
          [
            '-i',
            row.filePath,
            '-ac',
            '1', // mono
            '-ar',
            String(sampleRate), // low sample rate
            '-f',
            'f32le', // raw float32 little-endian
            '-acodec',
            'pcm_f32le',
            'pipe:1',
          ],
          { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 },
        );

        // Parse float32 samples
        const floats = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);

        // Bucket into numSamples peaks
        const samplesPerBucket = Math.max(1, Math.floor(floats.length / numSamples));
        const peaks: number[] = [];
        for (let i = 0; i < numSamples && i * samplesPerBucket < floats.length; i++) {
          let max = 0;
          const start = i * samplesPerBucket;
          const end = Math.min(start + samplesPerBucket, floats.length);
          for (let j = start; j < end; j++) {
            const abs = Math.abs(floats[j]);
            if (abs > max) max = abs;
          }
          peaks.push(Math.min(1, max));
        }

        reply.header('Cache-Control', 'public, max-age=3600');
        return { success: true, data: { peaks, sampleRate, duration } };
      } catch (err) {
        fastify.log.warn({ err }, 'Waveform generation failed');
        return reply.code(500).send({
          success: false,
          error: 'Waveform generation failed',
        });
      }
    },
  );

  // GET /media-file/:assetId - Serve media file with Range support for streaming
  fastify.get<{ Params: { assetId: string } }>(
    '/media-file/:assetId',
    {
      schema: {
        params: mediaFileParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, request.params.assetId)).get();
      if (!row) {
        return reply.code(404).send({ error: 'Media not found' });
      }

      if (!fs.existsSync(row.filePath)) {
        return reply.code(404).send({ error: 'File not found on disk' });
      }

      const stat = fs.statSync(row.filePath);
      const fileSize = stat.size;
      const range = request.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const stream = fs.createReadStream(row.filePath, { start, end });
        return reply
          .code(206)
          .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
          .header('Accept-Ranges', 'bytes')
          .header('Content-Length', chunkSize)
          .header('Content-Type', row.mimeType || 'application/octet-stream')
          .send(stream);
      }

      const stream = fs.createReadStream(row.filePath);
      return reply
        .header('Content-Length', fileSize)
        .header('Content-Type', row.mimeType || 'application/octet-stream')
        .header('Accept-Ranges', 'bytes')
        .send(stream);
    },
  );
};

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function mapMediaRow(row: typeof mediaAssets.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    type: row.type,
    filePath: row.filePath,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    duration: row.duration,
    frameRate: row.frameRateNum && row.frameRateDen ? { num: row.frameRateNum, den: row.frameRateDen } : null,
    resolution: row.width && row.height ? { width: row.width, height: row.height } : null,
    audioChannels: row.audioChannels,
    audioSampleRate: row.audioSampleRate,
    codec: row.codec,
    importedAt: row.importedAt,
    thumbnailPath: row.thumbnailPath,
    waveformDataPath: row.waveformDataPath,
    proxy: row.proxyPath ? { path: row.proxyPath, status: row.proxyStatus } : null,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}
