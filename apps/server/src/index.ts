import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { projectRoutes } from './routes/projects.js';
import { mediaRoutes } from './routes/media.js';
import { sequenceRoutes } from './routes/sequences.js';
import { exportRoutes } from './routes/export.js';
import { jobRoutes } from './routes/jobs.js';
import { initDatabase } from './db/client.js';
import path from 'path';

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  },
});

async function start() {
  // Register plugins
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Initialize database
  initDatabase();

  // Register routes
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.register(mediaRoutes, { prefix: '/api' });
  await app.register(sequenceRoutes, { prefix: '/api/sequences' });
  await app.register(exportRoutes, { prefix: '/api/export' });
  await app.register(jobRoutes, { prefix: '/api/jobs' });

  // Health check
  app.get('/api/health', async () => ({ status: 'ok', version: '0.1.0' }));

  // WebSocket endpoint
  app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, _req) => {
      socket.on('message', (message: Buffer) => {
        try {
          const data = JSON.parse(message.toString());
          app.log.info({ type: data.type }, 'WS message received');
        } catch {
          app.log.warn('Invalid WS message');
        }
      });

      socket.on('close', () => {
        app.log.info('WS client disconnected');
      });
    });
  });

  // Start server
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`LocalCut server running on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
