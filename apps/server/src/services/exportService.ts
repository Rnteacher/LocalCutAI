/**
 * Export service: resolves timeline sequence data into FFmpeg commands
 * and executes them as background jobs with progress reporting.
 */

import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { jobs, mediaAssets, sequences, projects } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportParams {
  sequenceId: string;
  outputDir?: string; // default: project dir / exports
  filename?: string; // default: "export-<timestamp>.mp4"
  format: 'mp4' | 'mov' | 'webm' | 'mkv';
  videoCodec: 'libx264' | 'libx265' | 'libvpx-vp9' | 'copy';
  audioCodec: 'aac' | 'libopus' | 'pcm_s16le' | 'copy';
  width?: number;
  height?: number;
  crf?: number; // Constant rate factor (default 18 for x264)
  preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
  audioBitrate?: string; // e.g. "192k"
  audioSampleRate?: number; // e.g. 48000
}

export interface ExportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  outputPath: string | null;
  error: string | null;
}

interface SequenceData {
  tracks: TrackData[];
}

interface TrackData {
  id: string;
  type: 'video' | 'audio';
  muted: boolean;
  volume: number;
  clips: ClipData[];
}

interface ClipData {
  id: string;
  mediaAssetId: string | null;
  type: 'video' | 'audio' | 'image' | 'gap';
  startTime: { frames: number; rate: { num: number; den: number } };
  duration: { frames: number; rate: { num: number; den: number } };
  sourceInPoint: { frames: number; rate: { num: number; den: number } };
  sourceOutPoint: { frames: number; rate: { num: number; den: number } };
  volume: number;
  disabled: boolean;
}

// Active processes for cancellation support
const activeProcesses = new Map<string, ChildProcess>();

// Progress callback type
type ProgressCallback = (jobId: string, progress: number, status: string) => void;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an export job. Returns job ID immediately; export runs in background.
 */
export async function startExport(
  params: ExportParams,
  onProgress?: ProgressCallback,
): Promise<ExportJob> {
  const db = getDb();

  // 1. Validate sequence exists
  const seqRow = db.select().from(sequences).where(eq(sequences.id, params.sequenceId)).get();
  if (!seqRow) {
    throw new Error(`Sequence not found: ${params.sequenceId}`);
  }

  // 2. Get project for output path
  const projectRow = db.select().from(projects).where(eq(projects.id, seqRow.projectId)).get();
  if (!projectRow) {
    throw new Error(`Project not found: ${seqRow.projectId}`);
  }

  // 3. Determine output path
  const outputDir = params.outputDir || path.join(projectRow.projectDir, 'exports');
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = params.format === 'mkv' ? 'mkv' : params.format;
  const filename = params.filename || `export-${timestamp}.${ext}`;
  const outputPath = path.join(outputDir, filename);

  // 4. Create job record
  const jobId = nanoid(12);
  const now = new Date().toISOString();
  db.insert(jobs).values({
    id: jobId,
    projectId: seqRow.projectId,
    type: 'export',
    status: 'queued',
    progress: 0,
    params: JSON.stringify({ ...params, outputPath }),
    createdAt: now,
  }).run();

  // 5. Parse sequence data
  const seqData: SequenceData = JSON.parse(seqRow.data);

  // 6. Run export asynchronously
  runExport(jobId, seqRow, seqData, params, outputPath, onProgress).catch((err) => {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    db.update(jobs).set({
      status: 'failed',
      error: errMsg,
      completedAt: new Date().toISOString(),
    }).where(eq(jobs.id, jobId)).run();
    onProgress?.(jobId, 0, 'failed');
  });

  return {
    id: jobId,
    status: 'queued',
    progress: 0,
    outputPath,
    error: null,
  };
}

/**
 * Cancel a running export.
 */
export function cancelExport(jobId: string): boolean {
  const proc = activeProcesses.get(jobId);
  if (proc) {
    proc.kill('SIGTERM');
    activeProcesses.delete(jobId);

    const db = getDb();
    db.update(jobs).set({
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    }).where(eq(jobs.id, jobId)).run();

    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal: Build and run FFmpeg
// ---------------------------------------------------------------------------

async function runExport(
  jobId: string,
  seqRow: typeof sequences.$inferSelect,
  seqData: SequenceData,
  params: ExportParams,
  outputPath: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  const db = getDb();

  // Update status to running
  db.update(jobs).set({
    status: 'running',
    startedAt: new Date().toISOString(),
  }).where(eq(jobs.id, jobId)).run();
  onProgress?.(jobId, 0, 'running');

  // Compute total duration in seconds from sequence data
  const seqFps = seqRow.frameRateNum / seqRow.frameRateDen;
  const totalDurationSec = computeSequenceDuration(seqData, seqFps);

  if (totalDurationSec <= 0) {
    throw new Error('Sequence is empty — nothing to export');
  }

  // Resolve all clips to media file paths
  const mediaMap = await resolveMediaPaths(seqData);

  // Build FFmpeg arguments
  const ffmpegArgs = buildFFmpegArgs(
    seqRow,
    seqData,
    params,
    outputPath,
    mediaMap,
    totalDurationSec,
  );

  // Execute FFmpeg
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(config.ffmpeg.ffmpegPath, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcesses.set(jobId, proc);

    let stderr = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();

      // Parse progress from FFmpeg stderr output
      const timeLine = chunk.toString().match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (timeLine && totalDurationSec > 0) {
        const hours = parseInt(timeLine[1], 10);
        const minutes = parseInt(timeLine[2], 10);
        const seconds = parseInt(timeLine[3], 10);
        const hundredths = parseInt(timeLine[4], 10);
        const currentTime = hours * 3600 + minutes * 60 + seconds + hundredths / 100;
        const progress = Math.min(currentTime / totalDurationSec, 0.99);

        db.update(jobs).set({ progress }).where(eq(jobs.id, jobId)).run();
        onProgress?.(jobId, progress, 'running');
      }
    });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);

      if (code === 0) {
        db.update(jobs).set({
          status: 'completed',
          progress: 1,
          completedAt: new Date().toISOString(),
        }).where(eq(jobs.id, jobId)).run();
        onProgress?.(jobId, 1, 'completed');
        resolve();
      } else {
        // Extract last few lines of stderr for error message
        const lastLines = stderr.split('\n').filter(l => l.trim()).slice(-5).join('\n');
        const errMsg = `FFmpeg exited with code ${code}: ${lastLines}`;
        db.update(jobs).set({
          status: 'failed',
          error: errMsg,
          completedAt: new Date().toISOString(),
        }).where(eq(jobs.id, jobId)).run();
        onProgress?.(jobId, 0, 'failed');
        reject(new Error(errMsg));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(jobId);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// FFmpeg argument builder
// ---------------------------------------------------------------------------

function buildFFmpegArgs(
  seqRow: typeof sequences.$inferSelect,
  seqData: SequenceData,
  params: ExportParams,
  outputPath: string,
  mediaMap: Map<string, string>, // assetId → filePath
  totalDurationSec: number,
): string[] {
  const seqFps = seqRow.frameRateNum / seqRow.frameRateDen;
  const width = params.width || seqRow.width;
  const height = params.height || seqRow.height;

  // Gather all active clips grouped by their role
  const videoClips: Array<{ clip: ClipData; track: TrackData; inputIndex: number }> = [];
  const audioClips: Array<{ clip: ClipData; track: TrackData; inputIndex: number }> = [];
  const inputFiles: string[] = [];
  const inputMap = new Map<string, number>(); // assetId → input index

  for (const track of seqData.tracks || []) {
    if (track.muted) continue;

    for (const clip of track.clips || []) {
      if (clip.disabled || !clip.mediaAssetId || clip.type === 'gap') continue;

      const filePath = mediaMap.get(clip.mediaAssetId);
      if (!filePath) continue;

      // Deduplicate inputs
      let inputIdx: number;
      if (inputMap.has(clip.mediaAssetId)) {
        inputIdx = inputMap.get(clip.mediaAssetId)!;
      } else {
        inputIdx = inputFiles.length;
        inputFiles.push(filePath);
        inputMap.set(clip.mediaAssetId, inputIdx);
      }

      if (track.type === 'video' && (clip.type === 'video' || clip.type === 'image')) {
        videoClips.push({ clip, track, inputIndex: inputIdx });
      }
      if (clip.type === 'video' || clip.type === 'audio') {
        // Video files also contribute audio if on an audio track or unmuted
        if (track.type === 'audio') {
          audioClips.push({ clip, track, inputIndex: inputIdx });
        } else if (track.type === 'video') {
          // Video tracks may carry audio — include as audio source
          audioClips.push({ clip, track, inputIndex: inputIdx });
        }
      }
    }
  }

  // If no clips, create a blank output
  if (videoClips.length === 0 && audioClips.length === 0) {
    return [
      '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${seqFps}:d=${totalDurationSec}`,
      '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`,
      '-t', totalDurationSec.toString(),
      '-c:v', params.videoCodec === 'copy' ? 'libx264' : params.videoCodec,
      '-c:a', params.audioCodec === 'copy' ? 'aac' : params.audioCodec,
      '-shortest',
      outputPath,
    ];
  }

  const args: string[] = ['-y']; // Overwrite output

  // Add input files
  for (const file of inputFiles) {
    args.push('-i', file);
  }

  // Build complex filter graph
  const filterParts: string[] = [];
  const videoOverlayLabels: string[] = [];
  const audioMixLabels: string[] = [];

  // --- Video processing ---
  // Create black background
  filterParts.push(
    `color=c=black:s=${width}x${height}:r=${seqFps}:d=${totalDurationSec}[base]`,
  );

  // Sort video clips by timeline position (bottom track first)
  const sortedVideoClips = [...videoClips].sort((a, b) => {
    const aStart = timeToSeconds(a.clip.startTime);
    const bStart = timeToSeconds(b.clip.startTime);
    return aStart - bStart;
  });

  let lastOverlay = 'base';

  for (let i = 0; i < sortedVideoClips.length; i++) {
    const { clip, inputIndex } = sortedVideoClips[i];
    const clipStart = timeToSeconds(clip.startTime);
    const clipDur = timeToSeconds(clip.duration);
    const inPoint = timeToSeconds(clip.sourceInPoint);
    const label = `v${i}`;
    const overlayLabel = `ov${i}`;

    // Trim + scale the video clip
    filterParts.push(
      `[${inputIndex}:v]trim=start=${inPoint}:duration=${clipDur},setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
      `setpts=PTS+${clipStart}/TB[${label}]`,
    );

    // Overlay onto previous layer
    filterParts.push(
      `[${lastOverlay}][${label}]overlay=enable='between(t,${clipStart},${clipStart + clipDur})':eof_action=pass[${overlayLabel}]`,
    );

    lastOverlay = overlayLabel;
  }

  // --- Audio processing ---
  if (audioClips.length > 0) {
    for (let i = 0; i < audioClips.length; i++) {
      const { clip, track, inputIndex } = audioClips[i];
      const clipStart = timeToSeconds(clip.startTime);
      const clipDur = timeToSeconds(clip.duration);
      const inPoint = timeToSeconds(clip.sourceInPoint);
      const gain = clip.volume * track.volume;
      const label = `a${i}`;

      filterParts.push(
        `[${inputIndex}:a]atrim=start=${inPoint}:duration=${clipDur},asetpts=PTS-STARTPTS,` +
        `volume=${gain},adelay=${Math.round(clipStart * 1000)}|${Math.round(clipStart * 1000)}[${label}]`,
      );
      audioMixLabels.push(`[${label}]`);
    }

    // Mix all audio
    if (audioMixLabels.length > 1) {
      filterParts.push(
        `${audioMixLabels.join('')}amix=inputs=${audioMixLabels.length}:duration=longest:dropout_transition=0[aout]`,
      );
    } else {
      // Single audio stream, just rename
      filterParts.push(
        `${audioMixLabels[0]}acopy[aout]`,
      );
    }
  } else {
    // Generate silent audio
    filterParts.push(
      `anullsrc=r=${params.audioSampleRate || 48000}:cl=stereo[aout]`,
    );
  }

  // Add filter_complex
  args.push('-filter_complex', filterParts.join(';\n'));

  // Map outputs
  args.push('-map', `[${lastOverlay}]`);
  args.push('-map', '[aout]');

  // Video codec settings
  if (params.videoCodec !== 'copy') {
    args.push('-c:v', params.videoCodec);
    args.push('-crf', (params.crf ?? 18).toString());
    if (params.preset) {
      args.push('-preset', params.preset);
    }
    args.push('-r', seqFps.toString());
    args.push('-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }

  // Audio codec settings
  if (params.audioCodec !== 'copy') {
    args.push('-c:a', params.audioCodec);
    if (params.audioBitrate) {
      args.push('-b:a', params.audioBitrate);
    }
    if (params.audioSampleRate) {
      args.push('-ar', params.audioSampleRate.toString());
    }
  } else {
    args.push('-c:a', 'copy');
  }

  // Duration limit
  args.push('-t', totalDurationSec.toString());

  // Output file
  args.push(outputPath);

  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeToSeconds(tv: { frames: number; rate: { num: number; den: number } }): number {
  if (!tv || !tv.rate || tv.rate.num === 0) return 0;
  const fps = tv.rate.num / tv.rate.den;
  return tv.frames / fps;
}

function computeSequenceDuration(seqData: SequenceData, fps: number): number {
  let maxEndTime = 0;

  for (const track of seqData.tracks || []) {
    for (const clip of track.clips || []) {
      if (clip.disabled) continue;
      const clipEnd = timeToSeconds(clip.startTime) + timeToSeconds(clip.duration);
      if (clipEnd > maxEndTime) {
        maxEndTime = clipEnd;
      }
    }
  }

  return maxEndTime;
}

async function resolveMediaPaths(seqData: SequenceData): Promise<Map<string, string>> {
  const db = getDb();
  const assetIds = new Set<string>();

  for (const track of seqData.tracks || []) {
    for (const clip of track.clips || []) {
      if (clip.mediaAssetId) {
        assetIds.add(clip.mediaAssetId);
      }
    }
  }

  const map = new Map<string, string>();

  for (const assetId of assetIds) {
    const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).get();
    if (row && fs.existsSync(row.filePath)) {
      map.set(assetId, row.filePath);
    }
  }

  return map;
}
