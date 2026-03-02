import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/client.js';
import { sequences } from '../db/schema.js';
import { eq } from 'drizzle-orm';

interface UpdateSequenceBody {
  name?: string;
  data?: Record<string, unknown>;
}

export const sequenceRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /:id — Get a sequence
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const db = getDb();
    const row = db.select().from(sequences).where(eq(sequences.id, request.params.id)).get();
    if (!row) {
      return reply.code(404).send({ success: false, error: 'Sequence not found' });
    }
    return { success: true, data: mapRow(row) };
  });

  // PUT /:id — Update sequence (name and/or data)
  fastify.put<{ Params: { id: string }; Body: UpdateSequenceBody }>('/:id', async (request, reply) => {
    const db = getDb();
    const existing = db.select().from(sequences).where(eq(sequences.id, request.params.id)).get();
    if (!existing) {
      return reply.code(404).send({ success: false, error: 'Sequence not found' });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (request.body?.name) updates.name = request.body.name;
    if (request.body?.data) updates.data = JSON.stringify(request.body.data);

    db.update(sequences).set(updates).where(eq(sequences.id, request.params.id)).run();
    const updated = db.select().from(sequences).where(eq(sequences.id, request.params.id)).get();
    return { success: true, data: mapRow(updated!) };
  });

  // DELETE /:id — Delete a sequence
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const db = getDb();
    const existing = db.select().from(sequences).where(eq(sequences.id, request.params.id)).get();
    if (!existing) {
      return reply.code(404).send({ success: false, error: 'Sequence not found' });
    }
    db.delete(sequences).where(eq(sequences.id, request.params.id)).run();
    return { success: true };
  });
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
