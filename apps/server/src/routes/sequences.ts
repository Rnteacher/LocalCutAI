import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/client.js';
import { sequences } from '../db/schema.js';
import { eq } from 'drizzle-orm';

interface UpdateSequenceBody {
  name?: string;
  data?: Record<string, unknown>;
  frameRate?: { num: number; den: number };
  resolution?: { width: number; height: number };
}

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
  },
} as const;

const updateSequenceBodySchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    data: { type: 'object' },
    frameRate: {
      type: 'object',
      required: ['num', 'den'],
      additionalProperties: false,
      properties: {
        num: { type: 'integer', minimum: 1, maximum: 960 },
        den: { type: 'integer', minimum: 1, maximum: 960 },
      },
    },
    resolution: {
      type: 'object',
      required: ['width', 'height'],
      additionalProperties: false,
      properties: {
        width: { type: 'integer', minimum: 1, maximum: 16384 },
        height: { type: 'integer', minimum: 1, maximum: 16384 },
      },
    },
  },
} as const;

export const sequenceRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /:id - Get a sequence
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: idParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const row = db.select().from(sequences).where(eq(sequences.id, request.params.id)).get();
      if (!row) {
        return reply.code(404).send({ success: false, error: 'Sequence not found' });
      }
      return { success: true, data: mapRow(row) };
    },
  );

  // PUT /:id - Update sequence (name and/or data)
  fastify.put<{ Params: { id: string }; Body: UpdateSequenceBody }>(
    '/:id',
    {
      schema: {
        params: idParamsSchema,
        body: updateSequenceBodySchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const existing = db.select().from(sequences).where(eq(sequences.id, request.params.id)).get();
      if (!existing) {
        return reply.code(404).send({ success: false, error: 'Sequence not found' });
      }

      const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (request.body?.name) updates.name = request.body.name;
      if (request.body?.data) updates.data = JSON.stringify(request.body.data);
      if (request.body?.frameRate) {
        updates.frameRateNum = request.body.frameRate.num;
        updates.frameRateDen = request.body.frameRate.den;
      }
      if (request.body?.resolution) {
        updates.width = request.body.resolution.width;
        updates.height = request.body.resolution.height;
      }

      const updated = db.transaction((tx) => {
        tx.update(sequences).set(updates).where(eq(sequences.id, request.params.id)).run();
        return tx.select().from(sequences).where(eq(sequences.id, request.params.id)).get();
      });
      return { success: true, data: mapRow(updated!) };
    },
  );

  // DELETE /:id - Delete a sequence
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: idParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const existing = db.select().from(sequences).where(eq(sequences.id, request.params.id)).get();
      if (!existing) {
        return reply.code(404).send({ success: false, error: 'Sequence not found' });
      }
      db.transaction((tx) => {
        tx.delete(sequences).where(eq(sequences.id, request.params.id)).run();
      });
      return { success: true };
    },
  );
};

function mapRow(row: typeof sequences.$inferSelect) {
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
