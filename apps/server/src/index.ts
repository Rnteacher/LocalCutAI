import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
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
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 * 1024 } }); // 10 GB
  await app.register(websocket);

  // Initialize database
  initDatabase();

  // ---------------------------------------------------------------------------
  // Serve frontend static files (production build from apps/web/dist)
  // ---------------------------------------------------------------------------
  const webDistDir = path.resolve(__dirname, '../../web/dist');
  const hasWebDist = fs.existsSync(webDistDir);

  if (hasWebDist) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      decorateReply: false,
    });
  }

  // Register API routes
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

  // ---------------------------------------------------------------------------
  // SPA fallback: any non-API, non-file request serves index.html
  // ---------------------------------------------------------------------------
  app.setNotFoundHandler(async (request, reply) => {
    // If it's an API route, return proper 404 JSON
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({
        success: false,
        error: `Route ${request.method}:${request.url} not found`,
      });
    }

    // For everything else, serve index.html (SPA client-side routing)
    if (hasWebDist) {
      const indexPath = path.join(webDistDir, 'index.html');
      const stream = fs.createReadStream(indexPath);
      return reply.type('text/html').send(stream);
    }

    // No frontend build available — show helpful dev message
    return reply.type('text/html').code(200).send(`
      <!DOCTYPE html>
      <html>
      <head><title>LocalCut Server</title></head>
      <body style="background:#18181b;color:#a1a1aa;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
        <div style="text-align:center;max-width:480px;">
          <h1 style="color:#60a5fa;font-size:1.5rem;">LocalCut Server v0.1.0</h1>
          <p>The API server is running on port <strong style="color:#e4e4e7">${config.port}</strong>.</p>
          <p style="margin-top:1rem;">To access the editor UI:</p>
          <ul style="text-align:left;line-height:2;">
            <li><strong>Dev mode:</strong> Run <code style="background:#27272a;padding:2px 6px;border-radius:4px;">pnpm turbo dev</code> and open <a href="http://localhost:3000" style="color:#60a5fa;">http://localhost:3000</a></li>
            <li><strong>Production:</strong> Run <code style="background:#27272a;padding:2px 6px;border-radius:4px;">pnpm turbo build</code> first, then this page will serve the UI</li>
          </ul>
          <p style="margin-top:1rem;font-size:0.875rem;">
            API health: <a href="/api/health" style="color:#60a5fa;">/api/health</a>
          </p>
        </div>
      </body>
      </html>
    `);
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
