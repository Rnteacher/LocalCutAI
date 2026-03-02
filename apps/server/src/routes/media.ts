import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../db/client.js';
import { mediaAssets, projects } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { probeFile, getMediaType } from '../util/ffprobe.js';
import fs from 'fs';
import path from 'path';

export const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /projects/:id/media/import — Import media by file path(s)
  fastify.post<{
    Params: { id: string };
    Body: { filePaths: string[] };
  }>('/projects/:id/media/import', async (request, reply) => {
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
  });

  // GET /projects/:id/media — List media assets for a project
  fastify.get<{ Params: { id: string } }>('/projects/:id/media', async (request, reply) => {
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
  });

  // GET /projects/:id/media/:assetId — Get a single media asset
  fastify.get<{ Params: { id: string; assetId: string } }>(
    '/projects/:id/media/:assetId',
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

  // DELETE /projects/:id/media/:assetId — Remove media from project
  fastify.delete<{ Params: { id: string; assetId: string } }>(
    '/projects/:id/media/:assetId',
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

  // GET /media-file/:assetId — Serve media file with Range support for streaming
  fastify.get<{ Params: { assetId: string } }>(
    '/media-file/:assetId',
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
    frameRate: row.frameRateNum && row.frameRateDen
      ? { num: row.frameRateNum, den: row.frameRateDen }
      : null,
    resolution: row.width && row.height
      ? { width: row.width, height: row.height }
      : null,
    audioChannels: row.audioChannels,
    audioSampleRate: row.audioSampleRate,
    codec: row.codec,
    importedAt: row.importedAt,
    thumbnailPath: row.thumbnailPath,
    waveformDataPath: row.waveformDataPath,
    proxy: row.proxyPath
      ? { path: row.proxyPath, status: row.proxyStatus }
      : null,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}
