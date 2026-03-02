import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  projectDir: text('project_dir').notNull(),
  settings: text('settings').notNull().default('{}'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
  updatedAt: text('updated_at').notNull().default("datetime('now')"),
});

export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['video', 'audio', 'image'] }).notNull(),
  filePath: text('file_path').notNull(),
  mimeType: text('mime_type'),
  fileSize: integer('file_size').default(0),
  duration: real('duration'),
  frameRateNum: integer('frame_rate_num'),
  frameRateDen: integer('frame_rate_den'),
  width: integer('width'),
  height: integer('height'),
  audioChannels: integer('audio_channels'),
  audioSampleRate: integer('audio_sample_rate'),
  codec: text('codec'),
  importedAt: text('imported_at').notNull().default("datetime('now')"),
  thumbnailPath: text('thumbnail_path'),
  waveformDataPath: text('waveform_data_path'),
  proxyPath: text('proxy_path'),
  proxyStatus: text('proxy_status').default('none'),
  metadata: text('metadata').default('{}'),
});

export const sequences = sqliteTable('sequences', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  frameRateNum: integer('frame_rate_num').notNull().default(24),
  frameRateDen: integer('frame_rate_den').notNull().default(1),
  width: integer('width').notNull().default(1920),
  height: integer('height').notNull().default(1080),
  data: text('data').notNull().default('{}'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
  updatedAt: text('updated_at').notNull().default("datetime('now')"),
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  status: text('status').notNull().default('queued'),
  progress: real('progress').notNull().default(0),
  params: text('params').notNull().default('{}'),
  error: text('error'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});
