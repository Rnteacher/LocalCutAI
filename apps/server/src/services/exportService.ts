/**
 * Export service: resolves sequence data into a core composition plan
 * and executes FFmpeg as a background job with progress reporting.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { jobs, mediaAssets, sequences, projects } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  buildCompositionPlan,
  timeValueToSeconds,
  type Sequence,
  type Track,
  type ClipItem,
  type TimeValue,
  type FrameRate,
  type BlendMode,
} from '../lib/core.js';

export interface ExportParams {
  sequenceId: string;
  outputDir?: string;
  filename?: string;
  format: 'mp4' | 'mov' | 'webm' | 'mkv';
  videoCodec: 'libx264' | 'libx265' | 'libvpx-vp9' | 'copy';
  audioCodec: 'aac' | 'libopus' | 'pcm_s16le' | 'copy';
  width?: number;
  height?: number;
  crf?: number;
  preset?:
    | 'ultrafast'
    | 'superfast'
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow'
    | 'slower'
    | 'veryslow';
  audioBitrate?: string;
  audioSampleRate?: number;
}

export interface ExportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  outputPath: string | null;
  error: string | null;
}

interface StoredSequenceData {
  tracks?: StoredTrackData[];
}

interface StoredTrackData {
  id: string;
  sequenceId?: string;
  name?: string;
  type?: 'video' | 'audio';
  index?: number;
  locked?: boolean;
  visible?: boolean;
  muted?: boolean;
  solo?: boolean;
  volume?: number;
  pan?: number;
  channelMode?: 'stereo' | 'mono';
  channelMap?: 'L+R' | 'L' | 'R';
  clips?: StoredClipData[];
}

interface StoredClipData {
  id: string;
  trackId?: string;
  mediaAssetId?: string | null;
  type?: 'video' | 'audio' | 'image' | 'gap' | string;
  name?: string;

  startFrame?: number;
  durationFrames?: number;
  sourceInFrame?: number;
  sourceOutFrame?: number;

  startTime?: TimeValue;
  duration?: TimeValue;
  sourceInPoint?: TimeValue;
  sourceOutPoint?: TimeValue;

  volume?: number;
  gain?: number;
  pan?: number;
  audioGainDb?: number;
  audioVolume?: number;
  audioPan?: number;
  opacity?: number;
  blendMode?: BlendMode;
  blendParams?: { silhouetteGamma?: number };
  disabled?: boolean;

  positionX?: number;
  positionY?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;

  brightness?: number;
  contrast?: number;
  saturation?: number;
  hue?: number;
  vignette?: number;

  keyframes?: Array<{
    id?: string;
    property?: string;
    frame?: number;
    value?: number;
    easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'bezier';
    bezierHandles?: { inX: number; inY: number; outX: number; outY: number };
    time?: { frames?: number };
  }>;
  transitionIn?: {
    id?: string;
    type?: string;
    durationFrames?: number;
    duration?: { frames?: number };
    audioCrossfade?: boolean;
  } | null;
  transitionOut?: {
    id?: string;
    type?: string;
    durationFrames?: number;
    duration?: { frames?: number };
    audioCrossfade?: boolean;
  } | null;
  masks?: unknown[];
  generator?: {
    kind?: 'black-video' | 'color-matte' | 'adjustment-layer' | string;
    color?: string;
  } | null;
}

interface StoredExportMeta {
  clipById: Map<string, StoredClipData>;
  trackAudioById: Map<
    string,
    {
      channelMode: 'stereo' | 'mono';
      channelMap: 'L+R' | 'L' | 'R';
    }
  >;
}

interface VideoSegment {
  clipId: string;
  trackId: string;
  mediaAssetId: string | null;
  generator: ClipItem['generator'];
  z: number;
  startFrame: number;
  endFrame: number;
  sourceStartFrame: number;
  opacity: number;
  blendMode: BlendMode;
  positionX: number;
  positionY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

interface AudioSegment {
  clipId: string;
  trackId: string;
  mediaAssetId: string;
  startFrame: number;
  endFrame: number;
  sourceStartFrame: number;
  gain: number;
  panLeft: number;
  panRight: number;
}

const activeProcesses = new Map<string, ChildProcess>();
type ProgressCallback = (jobId: string, progress: number, status: string) => void;

export async function startExport(
  params: ExportParams,
  onProgress?: ProgressCallback,
): Promise<ExportJob> {
  const db = getDb();

  const seqRow = db.select().from(sequences).where(eq(sequences.id, params.sequenceId)).get();
  if (!seqRow) {
    throw new Error(`Sequence not found: ${params.sequenceId}`);
  }

  const projectRow = db.select().from(projects).where(eq(projects.id, seqRow.projectId)).get();
  if (!projectRow) {
    throw new Error(`Project not found: ${seqRow.projectId}`);
  }

  const outputDir = resolveOutputDir(projectRow.projectDir, params.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = params.format === 'mkv' ? 'mkv' : params.format;
  const filename = sanitizeFilename(params.filename, `export-${timestamp}.${ext}`);
  const outputPath = path.join(outputDir, filename);

  const jobId = nanoid(12);
  const now = new Date().toISOString();
  db.insert(jobs)
    .values({
      id: jobId,
      projectId: seqRow.projectId,
      type: 'export',
      status: 'queued',
      progress: 0,
      params: JSON.stringify({ ...params, outputPath }),
      createdAt: now,
    })
    .run();

  const seqData = JSON.parse(seqRow.data) as StoredSequenceData;

  runExport(jobId, seqRow, seqData, params, outputPath, onProgress).catch((err) => {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    db.update(jobs)
      .set({
        status: 'failed',
        error: errMsg,
        completedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, jobId))
      .run();
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

export function cancelExport(jobId: string): boolean {
  const proc = activeProcesses.get(jobId);
  if (!proc) return false;

  proc.kill('SIGTERM');
  activeProcesses.delete(jobId);

  const db = getDb();
  db.update(jobs)
    .set({
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    })
    .where(eq(jobs.id, jobId))
    .run();

  return true;
}

async function runExport(
  jobId: string,
  seqRow: typeof sequences.$inferSelect,
  seqData: StoredSequenceData,
  params: ExportParams,
  outputPath: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  const db = getDb();

  db.update(jobs)
    .set({
      status: 'running',
      startedAt: new Date().toISOString(),
    })
    .where(eq(jobs.id, jobId))
    .run();
  onProgress?.(jobId, 0, 'running');

  const sequence = adaptStoredSequenceToCore(seqRow, seqData);
  const storedMeta = buildStoredExportMeta(seqData);
  const totalDurationSec = timeValueToSeconds(sequence.duration);
  if (totalDurationSec <= 0) {
    throw new Error('Sequence is empty - nothing to export');
  }

  const mediaMap = await resolveMediaPaths(sequence);
  const ffmpegArgs = buildFFmpegArgs(
    sequence,
    params,
    outputPath,
    mediaMap,
    totalDurationSec,
    storedMeta,
  );

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(config.ffmpeg.ffmpegPath, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcesses.set(jobId, proc);

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const timeLine = chunk.toString().match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (!timeLine || totalDurationSec <= 0) return;

      const hours = parseInt(timeLine[1], 10);
      const minutes = parseInt(timeLine[2], 10);
      const seconds = parseInt(timeLine[3], 10);
      const hundredths = parseInt(timeLine[4], 10);
      const currentTime = hours * 3600 + minutes * 60 + seconds + hundredths / 100;
      const progress = Math.min(currentTime / totalDurationSec, 0.99);

      db.update(jobs).set({ progress }).where(eq(jobs.id, jobId)).run();
      onProgress?.(jobId, progress, 'running');
    });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);
      const currentJob = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (currentJob?.status === 'cancelled') {
        onProgress?.(jobId, currentJob.progress ?? 0, 'cancelled');
        resolve();
        return;
      }

      if (code === 0) {
        db.update(jobs)
          .set({
            status: 'completed',
            progress: 1,
            completedAt: new Date().toISOString(),
          })
          .where(eq(jobs.id, jobId))
          .run();
        onProgress?.(jobId, 1, 'completed');
        resolve();
        return;
      }

      const lastLines = stderr
        .split('\n')
        .filter((l) => l.trim())
        .slice(-5)
        .join('\n');
      const errMsg = `FFmpeg exited with code ${code}: ${lastLines}`;
      db.update(jobs)
        .set({
          status: 'failed',
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, jobId))
        .run();
      onProgress?.(jobId, 0, 'failed');
      reject(new Error(errMsg));
    });

    proc.on('error', (err) => {
      activeProcesses.delete(jobId);
      const currentJob = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (currentJob?.status === 'cancelled') {
        onProgress?.(jobId, currentJob.progress ?? 0, 'cancelled');
        resolve();
        return;
      }
      reject(err);
    });
  });
}

function buildFFmpegArgs(
  sequence: Sequence,
  params: ExportParams,
  outputPath: string,
  mediaMap: Map<string, string>,
  totalDurationSec: number,
  storedMeta?: StoredExportMeta,
): string[] {
  const width = params.width || sequence.resolution.width;
  const height = params.height || sequence.resolution.height;
  const fps = sequence.frameRate.num / sequence.frameRate.den;

  const { videoSegments, audioSegments } = extractSegments(sequence);
  const inputFiles: string[] = [];
  const inputMap = new Map<string, number>();

  const registerInput = (mediaAssetId: string): number | null => {
    const filePath = mediaMap.get(mediaAssetId);
    if (!filePath) return null;
    if (inputMap.has(mediaAssetId)) {
      return inputMap.get(mediaAssetId)!;
    }
    const idx = inputFiles.length;
    inputFiles.push(filePath);
    inputMap.set(mediaAssetId, idx);
    return idx;
  };

  for (const seg of videoSegments) {
    if (seg.mediaAssetId) registerInput(seg.mediaAssetId);
  }
  for (const seg of audioSegments) registerInput(seg.mediaAssetId);

  if (videoSegments.length === 0 && audioSegments.length === 0) {
    return [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${width}x${height}:r=${fps}:d=${totalDurationSec}`,
      '-f',
      'lavfi',
      '-i',
      `anullsrc=r=${params.audioSampleRate || 48000}:cl=stereo`,
      '-t',
      totalDurationSec.toString(),
      '-c:v',
      params.videoCodec === 'copy' ? 'libx264' : params.videoCodec,
      '-c:a',
      params.audioCodec === 'copy' ? 'aac' : params.audioCodec,
      '-shortest',
      outputPath,
    ];
  }

  if (params.videoCodec === 'copy' || params.audioCodec === 'copy') {
    throw new Error(
      'Codec copy is not supported for timeline exports that require filtering.',
    );
  }

  const args: string[] = ['-y'];
  for (const file of inputFiles) {
    args.push('-i', file);
  }

  const filterParts: string[] = [];
  filterParts.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${totalDurationSec}[base]`);

  let lastOverlay = 'base';
  const sortedVideo = [...videoSegments].sort((a, b) => {
    if (a.z !== b.z) return a.z - b.z;
    return a.startFrame - b.startFrame;
  });

  for (let i = 0; i < sortedVideo.length; i++) {
    const seg = sortedVideo[i];

    const startSec = framesToSeconds(seg.startFrame, sequence.frameRate);
    const durSec = framesToSeconds(seg.endFrame - seg.startFrame, sequence.frameRate);
    const inSec = framesToSeconds(seg.sourceStartFrame, sequence.frameRate);
    const vLabel = `v${i}`;
    const ovLabel = `ov${i}`;
    const scaleX = Math.max(0.01, seg.scaleX);
    const scaleY = Math.max(0.01, seg.scaleY);
    const rotationRad = (seg.rotation * Math.PI) / 180;
    const overlayX = `(W-w)/2+${seg.positionX.toFixed(3)}`;
    const overlayY = `(H-h)/2+${seg.positionY.toFixed(3)}`;
    const clipMeta = storedMeta?.clipById.get(seg.clipId);
    const colorFilterChain = buildVideoColorFilterChain(clipMeta);
    const blendMode = seg.blendMode ?? 'normal';

    if (seg.generator?.kind === 'adjustment-layer') {
      throw new Error('Export for adjustment-layer is not supported yet in FFmpeg pipeline.');
    }

    if (seg.mediaAssetId) {
      const inputIndex = registerInput(seg.mediaAssetId);
      if (inputIndex == null) continue;
      filterParts.push(
        `[${inputIndex}:v]trim=start=${inSec}:duration=${durSec},setpts=PTS-STARTPTS,` +
          `scale='if(gt(a,${width}/${height}),${width},-2)':'if(gt(a,${width}/${height}),-2,${height})',` +
          `setsar=1,` +
          `${colorFilterChain}` +
          `scale=iw*${scaleX.toFixed(6)}:ih*${scaleY.toFixed(6)},` +
          `format=rgba,` +
          `rotate=${rotationRad.toFixed(8)}:ow=rotw(iw):oh=roth(ih):c=none,` +
          `colorchannelmixer=aa=${clamp01(seg.opacity)}[${vLabel}]`,
      );
    } else if (seg.generator?.kind === 'black-video' || seg.generator?.kind === 'color-matte') {
      const colorHex =
        seg.generator.kind === 'color-matte'
          ? (seg.generator.color ?? '#000000')
          : '#000000';
      const ffColor = /^#[0-9a-fA-F]{6}$/.test(colorHex) ? `0x${colorHex.slice(1)}` : 'black';
      filterParts.push(
        `color=c=${ffColor}:s=${width}x${height}:r=${fps}:d=${durSec},` +
          `${colorFilterChain}` +
          `scale=iw*${scaleX.toFixed(6)}:ih*${scaleY.toFixed(6)},` +
          `format=rgba,` +
          `rotate=${rotationRad.toFixed(8)}:ow=rotw(iw):oh=roth(ih):c=none,` +
          `colorchannelmixer=aa=${clamp01(seg.opacity)}[${vLabel}]`,
      );
    } else {
      continue;
    }

    if (blendMode === 'silhouette-alpha' || blendMode === 'silhouette-luma') {
      throw new Error(`Export blend mode '${blendMode}' is not supported yet in FFmpeg pipeline.`);
    }

    if (blendMode === 'normal') {
      filterParts.push(
        `[${lastOverlay}][${vLabel}]overlay=x='${overlayX}':y='${overlayY}':enable='between(t,${startSec},${startSec + durSec})':eof_action=pass[${ovLabel}]`,
      );
    } else {
      const segBase = `segbase${i}`;
      const segPos = `segpos${i}`;
      const ffBlendMode =
        blendMode === 'add'
          ? 'addition'
          : blendMode === 'multiply'
            ? 'multiply'
            : blendMode === 'screen'
              ? 'screen'
              : 'overlay';

      filterParts.push(`color=c=black@0:s=${width}x${height}:r=${fps}:d=${totalDurationSec}[${segBase}]`);
      filterParts.push(
        `[${segBase}][${vLabel}]overlay=x='${overlayX}':y='${overlayY}':enable='between(t,${startSec},${startSec + durSec})':eof_action=pass[${segPos}]`,
      );
      filterParts.push(`[${lastOverlay}][${segPos}]blend=all_mode=${ffBlendMode}[${ovLabel}]`);
    }

    lastOverlay = ovLabel;
  }

  const audioLabels: string[] = [];
  for (let i = 0; i < audioSegments.length; i++) {
    const seg = audioSegments[i];
    const inputIndex = registerInput(seg.mediaAssetId);
    if (inputIndex == null) continue;

    const startSec = framesToSeconds(seg.startFrame, sequence.frameRate);
    const durSec = framesToSeconds(seg.endFrame - seg.startFrame, sequence.frameRate);
    const inSec = framesToSeconds(seg.sourceStartFrame, sequence.frameRate);
    const delayMs = Math.max(0, Math.round(startSec * 1000));
    const gain = Math.max(0, seg.gain);
    const left = seg.panLeft.toFixed(4);
    const right = seg.panRight.toFixed(4);
    const aLabel = `a${i}`;
    const trackAudioCfg = storedMeta?.trackAudioById.get(seg.trackId);
    const channelMode = trackAudioCfg?.channelMode ?? 'stereo';
    const channelMap = trackAudioCfg?.channelMap ?? 'L+R';
    const panExpr = buildAudioPanExpression(channelMode, channelMap, left, right);

    filterParts.push(
      `[${inputIndex}:a]atrim=start=${inSec}:duration=${durSec},asetpts=PTS-STARTPTS,` +
        `aformat=channel_layouts=stereo,${panExpr},` +
        `volume=${gain.toFixed(6)},adelay=${delayMs}|${delayMs}[${aLabel}]`,
    );
    audioLabels.push(`[${aLabel}]`);
  }

  if (audioLabels.length === 0) {
    filterParts.push(`anullsrc=r=${params.audioSampleRate || 48000}:cl=stereo[aout]`);
  } else if (audioLabels.length === 1) {
    filterParts.push(`${audioLabels[0]}acopy[aout]`);
  } else {
    filterParts.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0[aout]`,
    );
  }

  args.push('-filter_complex', filterParts.join(';\n'));
  args.push('-map', `[${lastOverlay}]`);
  args.push('-map', '[aout]');

  args.push('-c:v', params.videoCodec);
  args.push('-crf', (params.crf ?? 18).toString());
  if (params.preset) args.push('-preset', params.preset);
  args.push('-r', fps.toString());
  args.push('-pix_fmt', 'yuv420p');

  args.push('-c:a', params.audioCodec);
  if (params.audioBitrate) args.push('-b:a', params.audioBitrate);
  if (params.audioSampleRate) args.push('-ar', params.audioSampleRate.toString());

  args.push('-t', totalDurationSec.toString());
  args.push(outputPath);
  return args;
}

function extractSegments(sequence: Sequence): {
  videoSegments: VideoSegment[];
  audioSegments: AudioSegment[];
} {
  const videoSegments: VideoSegment[] = [];
  const audioSegments: AudioSegment[] = [];

  const videoTrackOrder = new Map<string, number>();
  sequence.tracks
    .filter((t) => t.type === 'video')
    .slice()
    .reverse()
    .forEach((t, i) => {
      videoTrackOrder.set(t.id, i);
    });

  // Evaluate composition only at clip boundary intervals instead of every frame.
  const boundaries = new Set<number>([0, Math.max(0, sequence.duration.frames)]);
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      const start = Math.max(0, clip.startTime.frames);
      const end = Math.max(start, clip.startTime.frames + clip.duration.frames);
      boundaries.add(start);
      boundaries.add(end);

      if (clip.transitionIn) {
        const tDur = Math.max(0, clip.transitionIn.duration.frames);
        for (let f = 1; f < tDur; f++) {
          boundaries.add(start + f);
        }
      }
      if (clip.transitionOut) {
        const tDur = Math.max(0, clip.transitionOut.duration.frames);
        const outStart = Math.max(start, end - tDur);
        for (let f = outStart + 1; f < end; f++) {
          boundaries.add(f);
        }
      }

      const sortedKfs = [...clip.keyframes].sort((a, b) => a.time.frames - b.time.frames);
      if (sortedKfs.length > 1) {
        const kStart = Math.max(0, sortedKfs[0].time.frames);
        const kEnd = Math.min(clip.duration.frames, sortedKfs[sortedKfs.length - 1].time.frames);
        for (let f = kStart; f <= kEnd; f++) {
          boundaries.add(start + f);
        }
      } else {
        for (const kf of sortedKfs) {
          boundaries.add(start + Math.max(0, kf.time.frames));
        }
      }
    }
  }

  const orderedBoundaries = [...boundaries].sort((a, b) => a - b);

  const lastVideoByKey = new Map<string, VideoSegment>();
  const lastAudioByKey = new Map<string, AudioSegment>();

  for (let i = 0; i < orderedBoundaries.length - 1; i++) {
    const frameStart = orderedBoundaries[i];
    const frameEnd = orderedBoundaries[i + 1];
    if (frameEnd <= frameStart) continue;

    const time: TimeValue = { frames: frameStart, rate: sequence.frameRate };
    const plan = buildCompositionPlan(sequence, time);

    for (const layer of plan.videoLayers) {
      if (!layer.mediaAssetId && !layer.generator) continue;
      const z = videoTrackOrder.get(layer.trackId) ?? 0;
      const transitionOpacity = resolveTransitionOpacityMultiplier(
        layer.transitionType,
        layer.transitionProgress,
        layer.transitionPhase,
      );
      const opacity = clamp01(layer.opacity * transitionOpacity);
      const positionX = round3(layer.transform.positionX);
      const positionY = round3(layer.transform.positionY);
      const scaleX = round4(layer.transform.scaleX);
      const scaleY = round4(layer.transform.scaleY);
      const rotation = round3(layer.transform.rotation);
      const blendMode = layer.blendMode;
      const generatorKey = layer.generator
        ? `${layer.generator.kind}:${layer.generator.color ?? ''}`
        : 'none';
      const key = [
        layer.clipId,
        layer.trackId,
        layer.mediaAssetId ?? 'none',
        generatorKey,
        z,
        opacity.toFixed(4),
        blendMode,
        positionX.toFixed(3),
        positionY.toFixed(3),
        scaleX.toFixed(4),
        scaleY.toFixed(4),
        rotation.toFixed(3),
      ].join('|');

      const prev = lastVideoByKey.get(key);
      const expectedSourceFrame = prev
        ? prev.sourceStartFrame + (prev.endFrame - prev.startFrame)
        : -1;
      const isSequentialSource =
        layer.mediaAssetId != null && expectedSourceFrame === layer.sourceTime.frames;

      if (prev && prev.endFrame === frameStart && (layer.mediaAssetId == null || isSequentialSource)) {
        prev.endFrame = frameEnd;
      } else {
        const seg: VideoSegment = {
          clipId: layer.clipId,
          trackId: layer.trackId,
          mediaAssetId: layer.mediaAssetId,
          generator: layer.generator ?? null,
          z,
          startFrame: frameStart,
          endFrame: frameEnd,
          sourceStartFrame: layer.mediaAssetId ? layer.sourceTime.frames : 0,
          opacity,
          blendMode,
          positionX,
          positionY,
          scaleX,
          scaleY,
          rotation,
        };
        videoSegments.push(seg);
        lastVideoByKey.set(key, seg);
      }
    }

    for (const source of plan.audioSources) {
      if (!source.mediaAssetId) continue;
      const transitionGain = resolveTransitionAudioGain(
        source.transitionType,
        source.transitionProgress,
        source.transitionPhase,
        source.transitionAudioCrossfade,
      );
      const gain = source.gain * transitionGain;
      const key = [
        source.clipId,
        source.trackId,
        source.mediaAssetId,
        gain.toFixed(4),
        source.pan.left.toFixed(4),
        source.pan.right.toFixed(4),
      ].join('|');

      const prev = lastAudioByKey.get(key);
      const expectedSourceFrame = prev
        ? prev.sourceStartFrame + (prev.endFrame - prev.startFrame)
        : -1;

      if (
        prev &&
        prev.endFrame === frameStart &&
        expectedSourceFrame === source.sourceTime.frames
      ) {
        prev.endFrame = frameEnd;
      } else {
        const seg: AudioSegment = {
          clipId: source.clipId,
          trackId: source.trackId,
          mediaAssetId: source.mediaAssetId,
          startFrame: frameStart,
          endFrame: frameEnd,
          sourceStartFrame: source.sourceTime.frames,
          gain,
          panLeft: source.pan.left,
          panRight: source.pan.right,
        };
        audioSegments.push(seg);
        lastAudioByKey.set(key, seg);
      }
    }
  }

  return { videoSegments, audioSegments };
}

function adaptStoredSequenceToCore(
  seqRow: typeof sequences.$inferSelect,
  seqData: StoredSequenceData,
): Sequence {
  const frameRate: FrameRate = {
    num: seqRow.frameRateNum,
    den: seqRow.frameRateDen,
  };

  const tracks: Track[] = (seqData.tracks ?? []).map((track, idx) => {
    const type = track.type === 'audio' ? 'audio' : 'video';
    return {
      id: track.id,
      sequenceId: seqRow.id,
      name: track.name ?? `${type === 'video' ? 'V' : 'A'}${idx + 1}`,
      type,
      index: track.index ?? idx,
      locked: track.locked ?? false,
      visible: track.visible ?? true,
      muted: track.muted ?? false,
      solo: track.solo ?? false,
      volume: track.volume ?? 1,
      pan: track.pan ?? 0,
      clips: adaptStoredClips(track.id, track.clips ?? [], frameRate),
    };
  });

  let maxEnd = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      const end = clip.startTime.frames + clip.duration.frames;
      if (end > maxEnd) maxEnd = end;
    }
  }

  return {
    id: seqRow.id,
    projectId: seqRow.projectId,
    name: seqRow.name,
    frameRate,
    resolution: { width: seqRow.width, height: seqRow.height },
    duration: { frames: maxEnd, rate: frameRate },
    tracks,
    createdAt: seqRow.createdAt,
    updatedAt: seqRow.updatedAt,
  };
}

function normalizeStoredTransitionType(raw: unknown): 'cross-dissolve' | 'fade-black' {
  if (raw === 'fade-black') return 'fade-black';
  if (raw === 'cross-dissolve') return 'cross-dissolve';
  if (raw === 'dissolve' || raw === 'wipe-left' || raw === 'wipe-right') {
    return 'cross-dissolve';
  }
  return 'cross-dissolve';
}

function adaptStoredTransition(
  transition: StoredClipData['transitionIn'],
  rate: FrameRate,
): ClipItem['transitionIn'] {
  if (!transition) return null;
  const durationFrames = Math.max(
    0,
    Math.round(
      typeof transition.durationFrames === 'number'
        ? transition.durationFrames
        : typeof transition.duration?.frames === 'number'
          ? transition.duration.frames
          : 0,
    ),
  );
  if (durationFrames <= 0) return null;
  const type = normalizeStoredTransitionType(transition.type);
  return {
    id: typeof transition.id === 'string' && transition.id.length > 0 ? transition.id : nanoid(12),
    type,
    duration: framesToTimeValue(durationFrames, rate),
    audioCrossfade:
      typeof transition.audioCrossfade === 'boolean'
        ? transition.audioCrossfade
        : type === 'cross-dissolve',
  };
}

function adaptStoredKeyframes(clip: StoredClipData, rate: FrameRate): ClipItem['keyframes'] {
  if (!Array.isArray(clip.keyframes)) return [];
  const keyframes: ClipItem['keyframes'] = [];
  for (const kf of clip.keyframes) {
    if (!kf || typeof kf !== 'object') continue;
    if (typeof kf.property !== 'string' || typeof kf.value !== 'number') continue;
    const frame = Math.max(
      0,
      Math.round(
        typeof kf.frame === 'number'
          ? kf.frame
          : typeof kf.time?.frames === 'number'
            ? kf.time.frames
            : 0,
      ),
    );
    const easing =
      kf.easing === 'linear' ||
      kf.easing === 'ease-in' ||
      kf.easing === 'ease-out' ||
      kf.easing === 'ease-in-out' ||
      kf.easing === 'bezier'
        ? kf.easing
        : 'linear';
    keyframes.push({
      id: typeof kf.id === 'string' && kf.id.length > 0 ? kf.id : nanoid(12),
      clipId: clip.id,
      property: kf.property as ClipItem['keyframes'][number]['property'],
      time: framesToTimeValue(frame, rate),
      value: kf.value,
      easing,
      bezierHandles: kf.bezierHandles,
    });
  }
  keyframes.sort((a, b) => a.time.frames - b.time.frames);
  return keyframes;
}

function adaptStoredGenerator(generator: StoredClipData['generator']): ClipItem['generator'] {
  if (!generator || typeof generator !== 'object') return null;
  if (
    generator.kind !== 'black-video' &&
    generator.kind !== 'color-matte' &&
    generator.kind !== 'adjustment-layer'
  ) {
    return null;
  }
  if (generator.kind === 'color-matte') {
    return {
      kind: 'color-matte',
      color:
        typeof generator.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(generator.color)
          ? generator.color
          : '#000000',
    };
  }
  return { kind: generator.kind };
}

function adaptStoredClips(trackId: string, clips: StoredClipData[], rate: FrameRate): ClipItem[] {
  const coreClips = clips.map((clip) => {
    const startTime = clip.startTime ?? framesToTimeValue(clip.startFrame ?? 0, rate);
    const duration = clip.duration ?? framesToTimeValue(clip.durationFrames ?? 0, rate);

    const sourceInPoint = clip.sourceInPoint ?? framesToTimeValue(clip.sourceInFrame ?? 0, rate);

    const sourceOutPoint =
      clip.sourceOutPoint ??
      framesToTimeValue(
        clip.sourceOutFrame ??
          (clip.sourceInFrame ?? 0) + Math.max(1, clip.durationFrames ?? duration.frames),
        rate,
      );

    const volume = resolveStoredClipVolume(clip);
    const pan = resolveStoredClipPan(clip);

    return {
      id: clip.id,
      trackId,
      mediaAssetId: clip.mediaAssetId ?? null,
      type: normalizeClipType(clip.type),
      name: clip.name ?? clip.id,
      startTime,
      duration: { ...duration, frames: Math.max(1, duration.frames) },
      sourceInPoint,
      sourceOutPoint,
      volume,
      pan,
      audioEnvelope: [],
      transform: {
        positionX: clip.positionX ?? 0,
        positionY: clip.positionY ?? 0,
        scaleX: clip.scaleX ?? 1,
        scaleY: clip.scaleY ?? 1,
        rotation: clip.rotation ?? 0,
        anchorX: 0.5,
        anchorY: 0.5,
      },
      opacity: clip.opacity ?? 1,
      blendMode: clip.blendMode ?? 'normal',
      blendParams: {
        silhouetteGamma: clip.blendParams?.silhouetteGamma ?? 1,
      },
      keyframes: adaptStoredKeyframes(clip, rate),
      transitionIn: adaptStoredTransition(clip.transitionIn, rate),
      transitionOut: adaptStoredTransition(clip.transitionOut, rate),
      masks: [],
      generator: adaptStoredGenerator(clip.generator),
      disabled: clip.disabled ?? false,
    };
  });

  coreClips.sort((a, b) => a.startTime.frames - b.startTime.frames);
  return coreClips;
}

function buildStoredExportMeta(seqData: StoredSequenceData): StoredExportMeta {
  const clipById = new Map<string, StoredClipData>();
  const trackAudioById = new Map<
    string,
    {
      channelMode: 'stereo' | 'mono';
      channelMap: 'L+R' | 'L' | 'R';
    }
  >();

  for (const track of seqData.tracks ?? []) {
    trackAudioById.set(track.id, {
      channelMode: track.channelMode === 'mono' ? 'mono' : 'stereo',
      channelMap:
        track.channelMap === 'L' || track.channelMap === 'R' || track.channelMap === 'L+R'
          ? track.channelMap
          : 'L+R',
    });

    for (const clip of track.clips ?? []) {
      clipById.set(clip.id, clip);
    }
  }

  return { clipById, trackAudioById };
}

function buildVideoColorFilterChain(clip?: StoredClipData): string {
  if (!clip) return '';

  const brightness = clampRange(clip.brightness ?? 1, 0, 2);
  const contrast = clampRange(clip.contrast ?? 1, 0, 3);
  const saturation = clampRange(clip.saturation ?? 1, 0, 3);
  const hue = clampRange(clip.hue ?? 0, -180, 180);
  const vignette = clampRange(clip.vignette ?? 0, -1, 1);

  const filters: string[] = [];

  if (Math.abs(brightness - 1) > 0.0005) {
    filters.push(
      `lutrgb=r='clip(val*${brightness.toFixed(6)},0,255)':g='clip(val*${brightness.toFixed(6)},0,255)':b='clip(val*${brightness.toFixed(6)},0,255)'`,
    );
  }

  if (Math.abs(contrast - 1) > 0.0005) {
    filters.push(`eq=contrast=${contrast.toFixed(6)}`);
  }

  if (Math.abs(saturation - 1) > 0.0005 || Math.abs(hue) > 0.0005) {
    filters.push(`hue=s=${saturation.toFixed(6)}:h=${hue.toFixed(6)}`);
  }

  if (vignette > 0.0005) {
    const angle = 0.2 + Math.abs(vignette) * 1.1;
    filters.push(`vignette=angle=${angle.toFixed(6)}`);
  }

  return filters.length > 0 ? `${filters.join(',')},` : '';
}

function buildAudioPanExpression(
  channelMode: 'stereo' | 'mono',
  channelMap: 'L+R' | 'L' | 'R',
  left: string,
  right: string,
): string {
  if (channelMode === 'mono') {
    const monoSource = channelMap === 'L' ? 'c0' : channelMap === 'R' ? 'c1' : '0.5*c0+0.5*c1';
    return `pan=stereo|c0=${left}*(${monoSource})|c1=${right}*(${monoSource})`;
  }

  return `pan=stereo|c0=${left}*c0|c1=${right}*c1`;
}

function resolveStoredClipVolume(clip: StoredClipData): number {
  if (typeof clip.audioGainDb === 'number') {
    return dbToLinearGain(clip.audioGainDb);
  }
  if (typeof clip.gain === 'number') {
    return Math.max(0, clip.gain);
  }
  if (typeof clip.audioVolume === 'number') {
    return Math.max(0, clip.audioVolume);
  }
  if (typeof clip.volume === 'number') {
    return Math.max(0, clip.volume);
  }
  return 1;
}

function resolveStoredClipPan(clip: StoredClipData): number {
  const pan =
    typeof clip.pan === 'number' ? clip.pan : typeof clip.audioPan === 'number' ? clip.audioPan : 0;
  return clampRange(pan, -1, 1);
}

function dbToLinearGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  if (db <= -60) return 0;
  return Math.pow(10, db / 20);
}

function normalizeClipType(type: StoredClipData['type']): ClipItem['type'] {
  if (type === 'audio' || type === 'image' || type === 'gap') return type;
  return 'video';
}

function framesToTimeValue(frames: number, rate: FrameRate): TimeValue {
  return { frames: Math.max(0, Math.round(frames)), rate };
}

function framesToSeconds(frames: number, rate: FrameRate): number {
  if (rate.num === 0) return 0;
  return frames / (rate.num / rate.den);
}

function resolveTransitionOpacityMultiplier(
  type: string | null,
  progress: number | null,
  phase: 'in' | 'out' | null,
): number {
  if (!type || progress == null || !phase) return 1;
  const t = clamp01(progress);
  if (type === 'cross-dissolve' || type === 'fade-black' || type === 'dissolve') {
    return phase === 'in' ? t : 1 - t;
  }
  return 1;
}

function resolveTransitionAudioGain(
  type: string | null,
  progress: number | null,
  phase: 'in' | 'out' | null,
  audioCrossfade: boolean,
): number {
  if (!audioCrossfade || type !== 'cross-dissolve' || progress == null || !phase) {
    return 1;
  }
  const t = clamp01(progress);
  return phase === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export const __test__ = {
  adaptStoredSequenceToCore,
  extractSegments,
  buildFFmpegArgs,
  buildStoredExportMeta,
  sanitizeFilename,
  resolveOutputDir,
};

async function resolveMediaPaths(sequence: Sequence): Promise<Map<string, string>> {
  const db = getDb();
  const assetIds = new Set<string>();

  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaAssetId) assetIds.add(clip.mediaAssetId);
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

function sanitizeFilename(filename: string | undefined, fallback: string): string {
  const raw = (filename ?? fallback).trim();
  const basename = path.basename(raw);
  const sanitized = basename
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  return sanitized.length > 0 ? sanitized : fallback;
}

function resolveOutputDir(projectDir: string, requestedOutputDir?: string): string {
  const base = path.resolve(projectDir);
  if (!requestedOutputDir || requestedOutputDir.trim().length === 0) {
    return path.join(base, 'exports');
  }

  const candidate = path.resolve(base, requestedOutputDir);
  const relative = path.relative(base, candidate);
  const escapesBase =
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);

  if (escapesBase) {
    throw new Error('outputDir must stay inside the project directory');
  }

  return candidate;
}


