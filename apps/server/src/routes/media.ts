import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb, getSqlite } from '../db/client.js';
import { mediaAssets, projects, sequences } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { probeFile, getMediaType } from '../util/ffprobe.js';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { config } from '../config.js';
import {
  collectSequenceMediaReferences,
  chooseCanonicalMediaAsset,
  getMediaDedupeKey,
  mergeMediaDedupeMetadata,
  normalizeMediaPath,
  parseMediaMetadata,
  remapSequenceMediaReferences,
  serializeMediaMetadata,
} from '../util/mediaDedup.js';

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

type MediaRow = typeof mediaAssets.$inferSelect;
type SequenceRow = typeof sequences.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

interface MediaFingerprintInfo {
  normalizedPath: string;
  contentHash: string | null;
  dedupeKey: string;
  metadataRaw: string;
}

type MediaSourceKind = 'import' | 'upload' | 'unknown';

async function hashFile(filePath: string): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function isManagedProjectPath(projectDir: string, candidatePath: string | null | undefined): boolean {
  if (!candidatePath) return false;
  const mediaDir = normalizeMediaPath(path.join(projectDir, 'media'));
  const target = normalizeMediaPath(candidatePath);
  return target === mediaDir || target.startsWith(`${mediaDir}${path.sep}`);
}

function inferMediaSourceKind(
  row: Pick<MediaRow, 'filePath' | 'metadata'>,
  projectDir: string,
): MediaSourceKind {
  const currentKind = parseMediaMetadata(row.metadata).dedupe?.sourceKind;
  if (currentKind) return currentKind;
  return isManagedProjectPath(projectDir, row.filePath) ? 'upload' : 'import';
}

function buildMediaFingerprintInfo(
  row: Pick<MediaRow, 'filePath' | 'metadata'>,
  sourceKind: 'import' | 'upload' | 'unknown',
  contentHash: string | null,
): MediaFingerprintInfo {
  const normalizedPath = normalizeMediaPath(row.filePath);
  const merged = mergeMediaDedupeMetadata(row.metadata, {
    sourceKind,
    normalizedPath,
    contentHash: contentHash ?? undefined,
  });
  const metadataRaw = merged.changed ? serializeMediaMetadata(merged.metadata) : row.metadata || '{}';
  return {
    normalizedPath,
    contentHash,
    dedupeKey: getMediaDedupeKey({ filePath: row.filePath, metadata: metadataRaw })!,
    metadataRaw,
  };
}

async function resolveFingerprintForRow(
  row: MediaRow,
  sourceKind: MediaSourceKind,
  options?: { computeHash?: boolean },
): Promise<MediaFingerprintInfo> {
  const currentMetadata = parseMediaMetadata(row.metadata);
  let contentHash = currentMetadata.dedupe?.contentHash ?? null;
  if (!contentHash && options?.computeHash) {
    contentHash = await hashFile(row.filePath);
  }
  return buildMediaFingerprintInfo(row, sourceKind, contentHash);
}

async function persistMediaFingerprintInfo(
  db: ReturnType<typeof getDb>,
  row: MediaRow,
  info: MediaFingerprintInfo,
) {
  if ((row.metadata || '{}') === info.metadataRaw) return;
  db.update(mediaAssets)
    .set({ metadata: info.metadataRaw })
    .where(eq(mediaAssets.id, row.id))
    .run();
  row.metadata = info.metadataRaw;
}

async function ensureCandidateHashes(
  db: ReturnType<typeof getDb>,
  candidates: MediaRow[],
  projectDir: string,
  hashIndex: Map<string, MediaRow>,
) {
  for (const candidate of candidates) {
    const current = parseMediaMetadata(candidate.metadata);
    if (current.dedupe?.contentHash) {
      hashIndex.set(current.dedupe.contentHash, candidate);
      continue;
    }
    const info = await resolveFingerprintForRow(candidate, inferMediaSourceKind(candidate, projectDir), {
      computeHash: true,
    });
    if (info.contentHash) {
      hashIndex.set(info.contentHash, candidate);
    }
    await persistMediaFingerprintInfo(db, candidate, info);
  }
}

async function cleanupManagedMediaFiles(
  projectDir: string,
  duplicateRows: MediaRow[],
  retainedPaths: Set<string>,
) {
  let removedFiles = 0;
  const cleanupTargets = duplicateRows.flatMap((row) => [
    row.filePath,
    row.thumbnailPath,
    row.waveformDataPath,
    row.proxyPath,
  ]);

  for (const candidatePath of cleanupTargets) {
    if (!candidatePath) continue;
    const normalized = normalizeMediaPath(candidatePath);
    if (retainedPaths.has(normalized)) continue;
    if (!isManagedProjectPath(projectDir, candidatePath)) continue;
    if (!fs.existsSync(candidatePath)) continue;
    try {
      fs.unlinkSync(candidatePath);
      removedFiles += 1;
    } catch {
      // Ignore cleanup failures. The DB is already canonicalized.
    }
  }
  return removedFiles;
}

async function importMediaPathsForProject(
  db: ReturnType<typeof getDb>,
  project: ProjectRow,
  filePaths: string[],
) {
  const projectRows = db.select().from(mediaAssets).where(eq(mediaAssets.projectId, project.id)).all();
  const { pathIndex, hashIndex, missingHashBySize } = buildProjectMediaIndexes(projectRows);

  const imported: unknown[] = [];
  const errors: { path: string; error: string }[] = [];

  for (const filePath of filePaths) {
    try {
      if (!fs.existsSync(filePath)) {
        errors.push({ path: filePath, error: 'File not found' });
        continue;
      }

      const stat = fs.statSync(filePath);
      const normalizedPath = normalizeMediaPath(filePath);
      const existingByPath = pathIndex.get(normalizedPath);
      if (existingByPath) {
        imported.push(mapMediaRow(existingByPath));
        continue;
      }

      const incomingHash = await hashFile(filePath);
      if (incomingHash) {
        const existingByHash = hashIndex.get(incomingHash);
        if (existingByHash) {
          imported.push(mapMediaRow(existingByHash));
          continue;
        }

        const sizeCandidates = missingHashBySize.get(stat.size) ?? [];
        await ensureCandidateHashes(db, sizeCandidates, project.projectDir, hashIndex);
        missingHashBySize.delete(stat.size);
        const recheckedByHash = hashIndex.get(incomingHash);
        if (recheckedByHash) {
          imported.push(mapMediaRow(recheckedByHash));
          continue;
        }
      }

      const type = getMediaType(filePath);
      const probe = await probeFile(filePath);
      const id = nanoid(12);
      const now = new Date().toISOString();
      const fingerprint = buildMediaFingerprintInfo(
        { filePath, metadata: '{}' },
        'import',
        incomingHash,
      );

      db.insert(mediaAssets)
        .values({
          id,
          projectId: project.id,
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
          metadata: fingerprint.metadataRaw,
        })
        .run();

      const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
      imported.push(mapMediaRow(row!));
      if (row) {
        projectRows.push(row);
        pathIndex.set(fingerprint.normalizedPath, row);
        if (fingerprint.contentHash) {
          hashIndex.set(fingerprint.contentHash, row);
        }
      }
    } catch (err) {
      errors.push({
        path: filePath,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return { imported, errors };
}

async function openWindowsMediaPicker(): Promise<string[]> {
  if (process.platform !== 'win32') {
    throw new Error('Native media picker is currently available on Windows only');
  }

  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = $true
$dialog.Title = 'Link Media'
$dialog.Filter = 'Media Files|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.mxf;*.mp3;*.wav;*.aac;*.m4a;*.flac;*.ogg;*.png;*.jpg;*.jpeg;*.bmp;*.tif;*.tiff;*.gif;*.webp|All Files|*.*'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $dialog.FileNames | ConvertTo-Json -Compress
} else {
  '[]'
}
`.trim();

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', encoded],
    { windowsHide: false, maxBuffer: 1024 * 1024 },
  );
  const raw = `${stdout}`.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }
  return typeof parsed === 'string' && parsed.trim().length > 0 ? [parsed] : [];
}

function buildProjectMediaIndexes(rows: MediaRow[]) {
  const pathIndex = new Map<string, MediaRow>();
  const hashIndex = new Map<string, MediaRow>();
  const missingHashBySize = new Map<number, MediaRow[]>();

  for (const row of rows) {
    const metadata = parseMediaMetadata(row.metadata);
    const normalizedPath = metadata.dedupe?.normalizedPath ?? normalizeMediaPath(row.filePath);
    pathIndex.set(normalizedPath, row);

    const contentHash = metadata.dedupe?.contentHash;
    if (contentHash) {
      hashIndex.set(contentHash, row);
      continue;
    }

    const bucketKey = row.fileSize ?? 0;
    const bucket = missingHashBySize.get(bucketKey) ?? [];
    bucket.push(row);
    missingHashBySize.set(bucketKey, bucket);
  }

  return { pathIndex, hashIndex, missingHashBySize };
}

function collectRetainedPaths(rows: MediaRow[]): Set<string> {
  const retainedPaths = new Set<string>();
  for (const row of rows) {
    for (const candidatePath of [row.filePath, row.thumbnailPath, row.waveformDataPath, row.proxyPath]) {
      if (!candidatePath) continue;
      retainedPaths.add(normalizeMediaPath(candidatePath));
    }
  }
  return retainedPaths;
}

function mergeReferenceCounts(target: Record<string, number>, source: Record<string, number>) {
  for (const [assetId, count] of Object.entries(source)) {
    target[assetId] = (target[assetId] ?? 0) + count;
  }
}

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
      const { imported, errors } = await importMediaPathsForProject(db, project, filePaths);

      return {
        success: true,
        data: { imported, errors },
      };
    },
  );

  // POST /projects/:id/media/pick - Open native file picker and link media without copying
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/media/pick',
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

      const filePaths = await openWindowsMediaPicker();
      if (filePaths.length === 0) {
        return { success: true, data: { imported: [], errors: [] } };
      }

      const { imported, errors } = await importMediaPathsForProject(db, project, filePaths);
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

      const projectRows = db.select().from(mediaAssets).where(eq(mediaAssets.projectId, request.params.id)).all();
      const { hashIndex, missingHashBySize } = buildProjectMediaIndexes(projectRows);

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
          const contentHash = await hashFile(destPath);
          if (contentHash) {
            const existingByHash = hashIndex.get(contentHash);
            if (existingByHash) {
              fs.unlinkSync(destPath);
              imported.push(mapMediaRow(existingByHash));
              continue;
            }

            const sizeCandidates = (missingHashBySize.get(stat.size) ?? []).filter((row) => row.filePath !== destPath);
            await ensureCandidateHashes(db, sizeCandidates, project.projectDir, hashIndex);
            missingHashBySize.delete(stat.size);
            const recheckedByHash = hashIndex.get(contentHash);
            if (recheckedByHash) {
              fs.unlinkSync(destPath);
              imported.push(mapMediaRow(recheckedByHash));
              continue;
            }
          }

          const type = getMediaType(destPath);
          const probe = await probeFile(destPath);
          const id = nanoid(12);
          const now = new Date().toISOString();
          const fingerprint = buildMediaFingerprintInfo(
            { filePath: destPath, metadata: '{}' },
            'upload',
            contentHash,
          );

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
              metadata: fingerprint.metadataRaw,
            })
            .run();

          const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
          imported.push(mapMediaRow(row!));
          if (row) {
            projectRows.push(row);
            if (fingerprint.contentHash) {
              hashIndex.set(fingerprint.contentHash, row);
            }
          }
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

  // POST /projects/:id/media/dedupe - Canonicalize duplicate media assets within a project
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/media/dedupe',
    {
      schema: {
        params: projectIdParamsSchema,
      },
    },
    async (request, reply) => {
      const db = getDb();
      const sqlite = getSqlite();
      const project = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
      if (!project) {
        return reply.code(404).send({ success: false, error: 'Project not found' });
      }

      const rows = db.select().from(mediaAssets).where(eq(mediaAssets.projectId, request.params.id)).all();
      const projectSequences = db.select().from(sequences).where(eq(sequences.projectId, request.params.id)).all();

      const referenceCounts: Record<string, number> = {};
      for (const sequence of projectSequences) {
        try {
          mergeReferenceCounts(referenceCounts, collectSequenceMediaReferences(JSON.parse(sequence.data || '{}')));
        } catch {
          // Ignore malformed sequence payloads. They cannot be remapped safely here.
        }
      }

      const fingerprintById = new Map<string, MediaFingerprintInfo>();
      const groups = new Map<string, MediaRow[]>();
      for (const row of rows) {
        const info = await resolveFingerprintForRow(
          row,
          inferMediaSourceKind(row, project.projectDir),
          { computeHash: true },
        );
        fingerprintById.set(row.id, info);
        const bucket = groups.get(info.dedupeKey) ?? [];
        bucket.push(row);
        groups.set(info.dedupeKey, bucket);
      }

      const duplicateRows: MediaRow[] = [];
      const remap: Record<string, string> = {};
      let canonicalAssets = 0;
      for (const group of groups.values()) {
        if (group.length <= 1) continue;
        canonicalAssets += 1;
        const canonical = chooseCanonicalMediaAsset(group, referenceCounts);
        for (const row of group) {
          if (row.id === canonical.id) continue;
          duplicateRows.push(row);
          remap[row.id] = canonical.id;
        }
      }

      const updatedAt = new Date().toISOString();
      const sequenceUpdates = projectSequences
        .map((sequence) => {
          const remapped = remapSequenceMediaReferences(sequence.data, remap);
          if (!remapped.changed) return null;
          return { id: sequence.id, data: remapped.data };
        })
        .filter((value): value is { id: string; data: string } => value != null);

      const duplicateIds = new Set(duplicateRows.map((row) => row.id));
      const retainedRows = rows.filter((row) => !duplicateIds.has(row.id));
      const retainedPaths = collectRetainedPaths(retainedRows);

      const transaction = sqlite.transaction(() => {
        for (const row of rows) {
          const fingerprint = fingerprintById.get(row.id);
          if (!fingerprint || (row.metadata || '{}') === fingerprint.metadataRaw) continue;
          db.update(mediaAssets)
            .set({ metadata: fingerprint.metadataRaw })
            .where(eq(mediaAssets.id, row.id))
            .run();
        }

        for (const sequenceUpdate of sequenceUpdates) {
          db.update(sequences)
            .set({ data: sequenceUpdate.data, updatedAt })
            .where(eq(sequences.id, sequenceUpdate.id))
            .run();
        }

        for (const duplicate of duplicateRows) {
          db.delete(mediaAssets).where(eq(mediaAssets.id, duplicate.id)).run();
        }
      });

      transaction();
      const removedFiles = await cleanupManagedMediaFiles(project.projectDir, duplicateRows, retainedPaths);

      return {
        success: true,
        data: {
          totalAssets: rows.length,
          canonicalAssets,
          dedupedAssets: duplicateRows.length,
          updatedSequences: sequenceUpdates.length,
          removedFiles,
        },
      };
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
    metadata: parseMediaMetadata(row.metadata),
  };
}
