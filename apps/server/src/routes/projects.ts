import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../db/client.js';
import { projects, sequences } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';

interface CreateProjectBody {
  name: string;
  settings?: {
    defaultFrameRate?: { num: number; den: number };
    defaultResolution?: { width: number; height: number };
  };
}

interface UpdateProjectBody {
  name?: string;
  settings?: Record<string, unknown>;
}

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
  },
} as const;

const createProjectBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    settings: {
      type: 'object',
      additionalProperties: false,
      properties: {
        defaultFrameRate: {
          type: 'object',
          required: ['num', 'den'],
          additionalProperties: false,
          properties: {
            num: { type: 'integer', minimum: 1, maximum: 960 },
            den: { type: 'integer', minimum: 1, maximum: 960 },
          },
        },
        defaultResolution: {
          type: 'object',
          required: ['width', 'height'],
          additionalProperties: false,
          properties: {
            width: { type: 'integer', minimum: 1, maximum: 16384 },
            height: { type: 'integer', minimum: 1, maximum: 16384 },
          },
        },
      },
    },
  },
} as const;

const updateProjectBodySchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    settings: { type: 'object' },
  },
} as const;

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / - List all projects
  fastify.get('/', async () => {
    const db = getDb();
    const rows = db.select().from(projects).all();
    return {
      success: true,
      data: rows.map(mapProjectRow),
      total: rows.length,
      offset: 0,
      limit: 50,
    };
  });

  // POST / - Create a new project
  fastify.post<{ Body: CreateProjectBody }>(
    '/',
    {
      schema: {
        body: createProjectBodySchema,
      },
    },
    async (request, reply) => {
      const { name, settings } = request.body || {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ success: false, error: 'Name is required' });
      }

      const db = getDb();
      const id = nanoid(12);
      const now = new Date().toISOString();
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const projectDir = path.join(config.projectsDir, `${safeName}_${id}`);

      // Create project directory structure
      fs.mkdirSync(path.join(projectDir, 'media'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'proxies'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'thumbnails'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'waveforms'), { recursive: true });

      const defaultSettings = {
        defaultFrameRate: settings?.defaultFrameRate ?? { num: 24, den: 1 },
        defaultResolution: settings?.defaultResolution ?? { width: 1920, height: 1080 },
        proxyEnabled: true,
        proxyResolution: { width: 960, height: 540 },
        audioSampleRate: 48000,
        audioBitDepth: 16,
      };

      // Create default sequence
      const seqId = nanoid(12);
      const fr = defaultSettings.defaultFrameRate;
      const res = defaultSettings.defaultResolution;

      const row = db.transaction((tx) => {
        tx.insert(projects)
          .values({
            id,
            name: name.trim(),
            projectDir,
            settings: JSON.stringify(defaultSettings),
            createdAt: now,
            updatedAt: now,
          })
          .run();

        tx.insert(sequences)
          .values({
            id: seqId,
            projectId: id,
            name: 'Sequence 1',
            frameRateNum: fr.num,
            frameRateDen: fr.den,
            width: res.width,
            height: res.height,
            data: JSON.stringify({
              tracks: [
                { id: nanoid(12), sequenceId: seqId, name: 'V2', type: 'video', index: 0, locked: false, visible: true, muted: false, solo: false, volume: 1, pan: 0, clips: [] },
                { id: nanoid(12), sequenceId: seqId, name: 'V1', type: 'video', index: 1, locked: false, visible: true, muted: false, solo: false, volume: 1, pan: 0, clips: [] },
                { id: nanoid(12), sequenceId: seqId, name: 'A1', type: 'audio', index: 2, locked: false, visible: true, muted: false, solo: false, volume: 1, pan: 0, clips: [] },
                { id: nanoid(12), sequenceId: seqId, name: 'A2', type: 'audio', index: 3, locked: false, visible: true, muted: false, solo: false, volume: 1, pan: 0, clips: [] },
              ],
            }),
            createdAt: now,
            updatedAt: now,
          })
          .run();

        return tx.select().from(projects).where(eq(projects.id, id)).get();
      });

      return reply.code(201).send({ success: true, data: mapProjectRow(row!) });
    },
  );

  // GET /:id - Get a project by ID (includes sequences)
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: idParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const row = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!row) {
        return reply.code(404).send({ success: false, error: 'Project not found' });
      }

      const seqs = db.select().from(sequences).where(eq(sequences.projectId, row.id)).all();

      return {
        success: true,
        data: {
          ...mapProjectRow(row),
          sequences: seqs.map(mapSequenceRow),
        },
      };
    },
  );

  // PUT /:id - Update a project
  fastify.put<{ Params: { id: string }; Body: UpdateProjectBody }>(
    '/:id',
    {
      schema: {
        params: idParamsSchema,
        body: updateProjectBodySchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const existing = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!existing) {
        return reply.code(404).send({ success: false, error: 'Project not found' });
      }

      const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (request.body?.name) updates.name = request.body.name.trim();
      if (request.body?.settings) {
        const current = JSON.parse(existing.settings);
        updates.settings = JSON.stringify({ ...current, ...request.body.settings });
      }

      const updated = db.transaction((tx) => {
        tx.update(projects).set(updates).where(eq(projects.id, request.params.id)).run();
        return tx.select().from(projects).where(eq(projects.id, request.params.id)).get();
      });
      return { success: true, data: mapProjectRow(updated!) };
    },
  );

  // DELETE /:id - Delete a project
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: idParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const existing = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!existing) {
        return reply.code(404).send({ success: false, error: 'Project not found' });
      }

      // CASCADE will delete media_assets, sequences, and jobs
      db.transaction((tx) => {
        tx.delete(projects).where(eq(projects.id, request.params.id)).run();
      });
      fastify.log.info({ projectDir: existing.projectDir }, 'Project deleted; directory preserved');
      return { success: true };
    },
  );
};

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapProjectRow(row: typeof projects.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    projectDir: row.projectDir,
    settings: JSON.parse(row.settings),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapSequenceRow(row: typeof sequences.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    frameRate: { num: row.frameRateNum, den: row.frameRateDen },
    resolution: { width: row.width, height: row.height },
    data: JSON.parse(row.data),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
