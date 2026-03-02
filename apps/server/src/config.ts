import 'dotenv/config';
import path from 'path';
import os from 'os';

export const config = {
  port: parseInt(process.env.PORT || '9470', 10),
  host: process.env.HOST || 'localhost',

  aiServer: {
    port: parseInt(process.env.AI_SERVER_PORT || '9471', 10),
    host: process.env.AI_SERVER_HOST || 'localhost',
  },

  ffmpeg: {
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  },

  projectsDir: process.env.PROJECTS_DIR
    ? path.resolve(process.env.PROJECTS_DIR.replace('~', os.homedir()))
    : path.join(os.homedir(), 'LocalCut-Projects'),

  proxy: {
    enabled: process.env.PROXY_ENABLED !== 'false',
    resolution: process.env.PROXY_RESOLUTION || '960x540',
    codec: process.env.PROXY_CODEC || 'libx264',
    crf: parseInt(process.env.PROXY_CRF || '23', 10),
  },

  dbPath: path.resolve('./data/localcut.db'),
} as const;
