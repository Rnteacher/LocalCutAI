import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const jobRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / — List all jobs (optionally filter by projectId)
  fastify.get<{ Querystring: { projectId?: string } }>('/', async (request) => {
    const db = getDb();
    let query = db.select().from(jobs);
    if (request.query.projectId) {
      query = query.where(eq(jobs.projectId, request.query.projectId)) as typeof query;
    }
    const rows = query.all();
    return {
      success: true,
      data: rows.map(mapJobRow),
      total: rows.length,
      offset: 0,
      limit: 100,
    };
  });

  // GET /:id — Get a single job
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const db = getDb();
    const row = db.select().from(jobs).where(eq(jobs.id, request.params.id)).get();
    if (!row) {
      return reply.code(404).send({ success: false, error: 'Job not found' });
    }
    return { success: true, data: mapJobRow(row) };
  });

  // DELETE /:id — Cancel/delete a job
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const db = getDb();
    const row = db.select().from(jobs).where(eq(jobs.id, request.params.id)).get();
    if (!row) {
      return reply.code(404).send({ success: false, error: 'Job not found' });
    }
    db.delete(jobs).where(eq(jobs.id, request.params.id)).run();
    return { success: true };
  });
};

function mapJobRow(row: typeof jobs.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    status: row.status,
    progress: row.progress,
    params: JSON.parse(row.params),
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}
