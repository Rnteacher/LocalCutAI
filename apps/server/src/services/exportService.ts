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
  getPropertyValue,
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
  masks?: StoredMaskData[];
  generator?: {
    kind?: 'black-video' | 'color-matte' | 'adjustment-layer' | string;
    color?: string;
  } | null;
}

interface StoredMaskPoint {
  x?: number;
  y?: number;
  inX?: number;
  inY?: number;
  outX?: number;
  outY?: number;
}

interface StoredMaskShapeKeyframe {
  id?: string;
  frame?: number;
  points?: StoredMaskPoint[];
}

interface StoredMaskData {
  id?: string;
  name?: string;
  mode?: 'add' | 'subtract' | 'intersect' | string;
  closed?: boolean;
  invert?: boolean;
  opacity?: number;
  feather?: number;
  expansion?: number;
  keyframes?: StoredMaskShapeKeyframe[];
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

interface MediaDimensions {
  width: number;
  height: number;
}

interface ResolvedMediaInputs {
  pathById: Map<string, string>;
  dimensionsById: Map<string, MediaDimensions>;
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
  clipLocalStartFrame: number;
  opacity: number;
  blendMode: BlendMode;
  silhouetteGamma: number;
  masks: ClipItem['masks'];
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

  const mediaInputs = await resolveMediaInputs(sequence);
  const ffmpegArgs = buildFFmpegArgs(
    sequence,
    params,
    outputPath,
    mediaInputs.pathById,
    totalDurationSec,
    storedMeta,
    mediaInputs.dimensionsById,
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
  mediaDimensionsById?: Map<string, MediaDimensions>,
): string[] {
  const width = params.width || sequence.resolution.width;
  const height = params.height || sequence.resolution.height;
  const fps = sequence.frameRate.num / sequence.frameRate.den;

  const { videoSegments, audioSegments } = extractSegments(sequence);
  const clipById = new Map<string, ClipItem>();
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      clipById.set(clip.id, clip);
    }
  }
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
    const clipForMask = clipById.get(seg.clipId);

    let composeBase = lastOverlay;
    let adjustmentSourceLabel: string | null = null;
    if (seg.generator?.kind === 'adjustment-layer') {
      const adjSrc = `adjsrc${i}`;
      const adjBase = `adjbase${i}`;
      filterParts.push(`[${lastOverlay}]split[${adjSrc}][${adjBase}]`);
      composeBase = adjBase;
      adjustmentSourceLabel = adjSrc;
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
    } else if (seg.generator?.kind === 'adjustment-layer') {
      if (!adjustmentSourceLabel) continue;
      filterParts.push(
        `[${adjustmentSourceLabel}]${colorFilterChain}` +
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

    let segmentVisualLabel = vLabel;
    if ((seg.masks?.length ?? 0) > 0 && clipForMask) {
      const sourceDims =
        seg.mediaAssetId && mediaDimensionsById?.has(seg.mediaAssetId)
          ? mediaDimensionsById.get(seg.mediaAssetId)!
          : {
              width,
              height,
            };
      const maskEval = buildSegmentMaskExpression(
        clipForMask,
        seg.clipLocalStartFrame,
        sourceDims,
        sequence.resolution,
      );
      if (maskEval.expression) {
        const maskBaseLabel = `maskbase${i}`;
        const maskLabel =
          maskEval.blurSigma > 0.05 ? `maskblur${i}` : maskBaseLabel;
        const alphaSrcLabel = `asrc${i}`;
        const alphaMulLabel = `amul${i}`;
        const rgbSrcLabel = `rgbsrc${i}`;
        const maskedLabel = `vm${i}`;
        filterParts.push(
          `[${vLabel}]format=gray,geq=lum='255*${escapeFfmpegExpression(maskEval.expression)}'[${maskBaseLabel}]`,
        );
        if (maskEval.blurSigma > 0.05) {
          filterParts.push(
            `[${maskBaseLabel}]gblur=sigma=${Math.min(128, maskEval.blurSigma).toFixed(4)}[${maskLabel}]`,
          );
        }
        filterParts.push(`[${vLabel}]alphaextract[${alphaSrcLabel}]`);
        filterParts.push(`[${alphaSrcLabel}][${maskLabel}]blend=all_mode=multiply[${alphaMulLabel}]`);
        filterParts.push(`[${vLabel}]format=rgba[${rgbSrcLabel}]`);
        filterParts.push(`[${rgbSrcLabel}][${alphaMulLabel}]alphamerge[${maskedLabel}]`);
        segmentVisualLabel = maskedLabel;
      }
    }

    if (blendMode === 'normal') {
      filterParts.push(
        `[${composeBase}][${segmentVisualLabel}]overlay=x='${overlayX}':y='${overlayY}':enable='between(t,${startSec},${startSec + durSec})':eof_action=pass[${ovLabel}]`,
      );
    } else {
      const segBase = `segbase${i}`;
      const segPos = `segpos${i}`;

      filterParts.push(`color=c=black@0:s=${width}x${height}:r=${fps}:d=${totalDurationSec}[${segBase}]`);
      filterParts.push(
        `[${segBase}][${segmentVisualLabel}]overlay=x='${overlayX}':y='${overlayY}':enable='between(t,${startSec},${startSec + durSec})':eof_action=pass[${segPos}]`,
      );

      if (blendMode === 'silhouette-alpha' || blendMode === 'silhouette-luma') {
        const maskLabel = `mask${i}`;
        const maskInvLabel = `maski${i}`;
        const baseAlphaLabel = `basea${i}`;
        if (blendMode === 'silhouette-alpha') {
          filterParts.push(`[${segPos}]alphaextract[${maskLabel}]`);
        } else {
          const gamma = clampRange(seg.silhouetteGamma ?? 1, 0.1, 8);
          filterParts.push(
            `[${segPos}]format=gray,lut=y='pow(val/255\\,${gamma.toFixed(6)})*255'[${maskLabel}]`,
          );
        }
        filterParts.push(`[${maskLabel}]negate[${maskInvLabel}]`);
        filterParts.push(`[${composeBase}]format=rgba[${baseAlphaLabel}]`);
        filterParts.push(`[${baseAlphaLabel}][${maskInvLabel}]alphamerge[${ovLabel}]`);
      } else {
        const ffBlendMode =
          blendMode === 'add'
            ? 'addition'
            : blendMode === 'multiply'
              ? 'multiply'
              : blendMode === 'screen'
                ? 'screen'
                : 'overlay';
        filterParts.push(`[${composeBase}][${segPos}]blend=all_mode=${ffBlendMode}[${ovLabel}]`);
      }
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
  const clipById = new Map<string, ClipItem>();
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      clipById.set(clip.id, clip);
    }
  }

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

      for (const mask of clip.masks ?? []) {
        const sortedMaskKfs = [...mask.keyframes].sort((a, b) => a.frame - b.frame);
        if (sortedMaskKfs.length > 1) {
          const mStart = Math.max(0, sortedMaskKfs[0].frame);
          const mEnd = Math.min(clip.duration.frames, sortedMaskKfs[sortedMaskKfs.length - 1].frame);
          for (let f = mStart; f <= mEnd; f++) {
            boundaries.add(start + f);
          }
        } else {
          for (const kf of sortedMaskKfs) {
            boundaries.add(start + Math.max(0, kf.frame));
          }
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

    const mergeVideoSegment = (
      key: string,
      seg: VideoSegment,
      sequentialSourceFrame: number | null,
    ): void => {
      const prev = lastVideoByKey.get(key);
      const expectedSourceFrame = prev
        ? prev.sourceStartFrame + (prev.endFrame - prev.startFrame)
        : -1;
      const isSequentialSource =
        sequentialSourceFrame == null || expectedSourceFrame === sequentialSourceFrame;

      if (prev && prev.endFrame === frameStart && isSequentialSource) {
        prev.endFrame = frameEnd;
        return;
      }

      videoSegments.push(seg);
      lastVideoByKey.set(key, seg);
    };

    for (const layer of plan.videoLayers) {
      if (!layer.mediaAssetId && !layer.generator) continue;
      const clip = clipById.get(layer.clipId);
      const z = videoTrackOrder.get(layer.trackId) ?? 0;
      const transitionOpacity = resolveTransitionOpacityMultiplier(
        layer.transitionType,
        layer.transitionProgress,
        layer.transitionPhase,
      );
      const fadeBlackOpacity = resolveFadeBlackOverlayOpacity(
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
      const silhouetteGamma = clampRange(clip?.blendParams?.silhouetteGamma ?? 1, 0.1, 8);
      const clipLocalStartFrame = clip ? Math.max(0, frameStart - clip.startTime.frames) : 0;
      const hasAnimatedMaskShape =
        (clip?.masks ?? []).some((mask) => (mask.keyframes?.length ?? 0) > 1);
      const hasAnimatedMaskParams =
        (clip?.keyframes ?? []).filter(
          (kf) =>
            kf.property === 'mask.opacity' ||
            kf.property === 'mask.feather' ||
            kf.property === 'mask.expansion',
        ).length > 1;
      const maskMergeToken =
        hasAnimatedMaskShape || hasAnimatedMaskParams ? `maskf:${clipLocalStartFrame}` : 'maskf:static';

      if (opacity > 0.0001) {
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
          silhouetteGamma.toFixed(4),
          maskMergeToken,
          positionX.toFixed(3),
          positionY.toFixed(3),
          scaleX.toFixed(4),
          scaleY.toFixed(4),
          rotation.toFixed(3),
        ].join('|');

        mergeVideoSegment(
          key,
          {
            clipId: layer.clipId,
            trackId: layer.trackId,
            mediaAssetId: layer.mediaAssetId,
            generator: layer.generator ?? null,
            z,
            startFrame: frameStart,
            endFrame: frameEnd,
            sourceStartFrame: layer.mediaAssetId ? layer.sourceTime.frames : 0,
            clipLocalStartFrame,
            opacity,
            blendMode,
            silhouetteGamma,
            masks: clip?.masks ?? [],
            positionX,
            positionY,
            scaleX,
            scaleY,
            rotation,
          },
          layer.mediaAssetId ? layer.sourceTime.frames : null,
        );
      }

      if (fadeBlackOpacity > 0.0001) {
        const fadeOpacity = clamp01(layer.opacity * fadeBlackOpacity);
        const fadeKey = [
          layer.clipId,
          layer.trackId,
          'fade-black-overlay',
          z.toFixed(4),
          fadeOpacity.toFixed(4),
          maskMergeToken,
          positionX.toFixed(3),
          positionY.toFixed(3),
          scaleX.toFixed(4),
          scaleY.toFixed(4),
          rotation.toFixed(3),
        ].join('|');

        mergeVideoSegment(
          fadeKey,
          {
            clipId: layer.clipId,
            trackId: layer.trackId,
            mediaAssetId: null,
            generator: { kind: 'black-video' },
            z: z + 0.0001,
            startFrame: frameStart,
            endFrame: frameEnd,
            sourceStartFrame: 0,
            clipLocalStartFrame,
            opacity: fadeOpacity,
            blendMode: 'normal',
            silhouetteGamma: 1,
            masks: clip?.masks ?? [],
            positionX,
            positionY,
            scaleX,
            scaleY,
            rotation,
          },
          null,
        );
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

type CoreMaskPoint = ClipItem['masks'][number]['keyframes'][number]['points'][number];

interface RasterMaskPoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

function buildSegmentMaskExpression(
  clip: ClipItem,
  clipLocalFrame: number,
  sourceDimensions: MediaDimensions,
  outputResolution: { width: number; height: number },
): { expression: string | null; blurSigma: number } {
  const masks = clip.masks ?? [];
  if (masks.length === 0) return { expression: null, blurSigma: 0 };

  const localTime: TimeValue = {
    frames: Math.max(0, Math.round(clipLocalFrame)),
    rate: clip.startTime.rate,
  };
  const keyframedMaskOpacity = clamp01(getPropertyValue(clip, 'mask.opacity', localTime));
  const keyframedMaskFeather = Math.max(0, getPropertyValue(clip, 'mask.feather', localTime));
  const keyframedMaskExpansion = getPropertyValue(clip, 'mask.expansion', localTime);
  const sourceScale =
    (outputResolution.width / Math.max(1, sourceDimensions.width) +
      outputResolution.height / Math.max(1, sourceDimensions.height)) /
    2;
  const sizeScale = Math.max(1, (outputResolution.width + outputResolution.height) / 2);

  const addTerms: string[] = [];
  const intersectTerms: string[] = [];
  const subtractTerms: string[] = [];
  let maxBlurSigma = 0;

  for (const mask of masks) {
    const resolvedPoints = resolveMaskShapeAtFrame(mask, clipLocalFrame);
    if (resolvedPoints.length < 2) continue;

    const opacity = clamp01((mask.opacity ?? 1) * keyframedMaskOpacity);
    if (opacity <= 0.0001) continue;

    const featherPx = Math.max(0, ((mask.feather ?? 0) + keyframedMaskFeather) * sourceScale);
    const expansionPx = ((mask.expansion ?? 0) + keyframedMaskExpansion) * sourceScale;
    const expansionNorm = expansionPx / sizeScale;

    const closedPath = mask.closed !== false || resolvedPoints.length >= 3;
    const normalizedPoints = mapMaskPointsToNormalized(
      resolvedPoints,
      sourceDimensions,
      expansionNorm,
    );
    const polygon = flattenMaskPath(normalizedPoints, closedPath);
    if (polygon.length < 3) continue;

    const insideExpr = buildPointInPolygonExpression(polygon);
    if (!insideExpr) continue;
    const term = `(${insideExpr})*${opacity.toFixed(6)}`;

    const effectiveMode = resolveEffectiveMaskMode(mask.mode, mask.invert === true);
    if (effectiveMode === 'add') {
      addTerms.push(term);
    } else if (effectiveMode === 'intersect') {
      intersectTerms.push(term);
    } else {
      subtractTerms.push(term);
    }

    maxBlurSigma = Math.max(maxBlurSigma, featherPx);
  }

  if (addTerms.length === 0 && intersectTerms.length === 0 && subtractTerms.length === 0) {
    return { expression: null, blurSigma: 0 };
  }

  let acc = addTerms.length === 0 ? '1' : '0';
  for (const term of addTerms) {
    acc = `max(${acc},${term})`;
  }
  for (const term of intersectTerms) {
    acc = `min(${acc},${term})`;
  }
  for (const term of subtractTerms) {
    acc = `(${acc})*(1-(${term}))`;
  }

  return {
    expression: `max(0,min(1,${acc}))`,
    blurSigma: maxBlurSigma,
  };
}

function resolveEffectiveMaskMode(
  mode: ClipItem['masks'][number]['mode'],
  invert: boolean,
): 'add' | 'subtract' | 'intersect' {
  if (!invert) return mode;
  if (mode === 'add') return 'subtract';
  if (mode === 'subtract') return 'add';
  return 'intersect';
}

function resolveMaskShapeAtFrame(
  mask: ClipItem['masks'][number],
  clipLocalFrame: number,
): CoreMaskPoint[] {
  const keyframes = [...(mask.keyframes ?? [])].sort((a, b) => a.frame - b.frame);
  if (keyframes.length === 0) return [];
  if (keyframes.length === 1) return keyframes[0].points.map((p) => ({ ...p }));

  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (clipLocalFrame <= first.frame) return first.points.map((p) => ({ ...p }));
  if (clipLocalFrame >= last.frame) return last.points.map((p) => ({ ...p }));

  for (let i = 0; i < keyframes.length - 1; i++) {
    const from = keyframes[i];
    const to = keyframes[i + 1];
    if (clipLocalFrame < from.frame || clipLocalFrame > to.frame) continue;

    const t = (clipLocalFrame - from.frame) / Math.max(1, to.frame - from.frame);
    if (from.points.length !== to.points.length) {
      return (t < 0.5 ? from.points : to.points).map((p) => ({ ...p }));
    }
    return from.points.map((a, idx) => {
      const b = to.points[idx];
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        inX: a.inX + (b.inX - a.inX) * t,
        inY: a.inY + (b.inY - a.inY) * t,
        outX: a.outX + (b.outX - a.outX) * t,
        outY: a.outY + (b.outY - a.outY) * t,
      };
    });
  }

  return first.points.map((p) => ({ ...p }));
}

function mapMaskPointsToNormalized(
  points: CoreMaskPoint[],
  sourceDimensions: MediaDimensions,
  expansionNorm: number,
): RasterMaskPoint[] {
  const srcW = Math.max(1, sourceDimensions.width);
  const srcH = Math.max(1, sourceDimensions.height);
  const normalized = points.every(
    (p) =>
      Math.abs(p.x) <= 1.5 &&
      Math.abs(p.y) <= 1.5 &&
      Math.abs(p.inX) <= 1.5 &&
      Math.abs(p.inY) <= 1.5 &&
      Math.abs(p.outX) <= 1.5 &&
      Math.abs(p.outY) <= 1.5,
  );
  const mapX = (value: number) => (normalized ? value : value / srcW);
  const mapY = (value: number) => (normalized ? value : value / srcH);

  const mapped = points.map((p) => ({
    x: mapX(p.x),
    y: mapY(p.y),
    inX: mapX(p.inX),
    inY: mapY(p.inY),
    outX: mapX(p.outX),
    outY: mapY(p.outY),
  }));
  if (Math.abs(expansionNorm) <= 0.000001 || mapped.length === 0) {
    return mapped;
  }

  const center = mapped.reduce(
    (acc, p) => {
      acc.x += p.x;
      acc.y += p.y;
      return acc;
    },
    { x: 0, y: 0 },
  );
  center.x /= mapped.length;
  center.y /= mapped.length;

  return mapped.map((p) => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.000001) return { ...p };
    const ox = (dx / len) * expansionNorm;
    const oy = (dy / len) * expansionNorm;
    return {
      x: p.x + ox,
      y: p.y + oy,
      inX: p.inX + ox,
      inY: p.inY + oy,
      outX: p.outX + ox,
      outY: p.outY + oy,
    };
  });
}

function flattenMaskPath(points: RasterMaskPoint[], closed: boolean): Array<{ x: number; y: number }> {
  if (points.length < 2) return [];
  const polyline: Array<{ x: number; y: number }> = [];
  const segmentCount = closed ? points.length : points.length - 1;

  const pushPoint = (x: number, y: number): void => {
    const prev = polyline[polyline.length - 1];
    if (prev && Math.abs(prev.x - x) < 0.0001 && Math.abs(prev.y - y) < 0.0001) return;
    polyline.push({ x, y });
  };

  for (let i = 0; i < segmentCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (i === 0) pushPoint(a.x, a.y);

    const approxLen =
      Math.hypot(a.x - a.outX, a.y - a.outY) +
      Math.hypot(a.outX - b.inX, a.outY - b.inY) +
      Math.hypot(b.inX - b.x, b.inY - b.y);
    const steps = Math.max(6, Math.min(64, Math.round(approxLen * 120)));

    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const omt = 1 - t;
      const x =
        omt * omt * omt * a.x +
        3 * omt * omt * t * a.outX +
        3 * omt * t * t * b.inX +
        t * t * t * b.x;
      const y =
        omt * omt * omt * a.y +
        3 * omt * omt * t * a.outY +
        3 * omt * t * t * b.inY +
        t * t * t * b.y;
      pushPoint(x, y);
    }
  }

  if (closed && polyline.length > 2) {
    const first = polyline[0];
    const last = polyline[polyline.length - 1];
    if (Math.abs(first.x - last.x) < 0.0001 && Math.abs(first.y - last.y) < 0.0001) {
      polyline.pop();
    }
  }

  return polyline;
}

function buildPointInPolygonExpression(points: Array<{ x: number; y: number }>): string | null {
  if (points.length < 3) return null;
  const yExpr = '(Y/H)';
  const xExpr = '(X/W)';
  const intersections: string[] = [];

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ax = a.x.toFixed(6);
    const ay = a.y.toFixed(6);
    const bx = b.x.toFixed(6);
    const by = b.y.toFixed(6);
    const crosses = `mod(gt(${ay},${yExpr})+gt(${by},${yExpr}),2)`;
    const xIntersect = `${ax}+(((${bx})-(${ax}))*(${yExpr}-(${ay}))/(((${by})-(${ay}))+0.000001))`;
    intersections.push(`((${crosses})*lt(${xExpr},${xIntersect}))`);
  }

  return `mod(${intersections.join('+')},2)`;
}

function escapeFfmpegExpression(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,');
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

function adaptStoredMasks(rawMasks: StoredClipData['masks']): ClipItem['masks'] {
  if (!Array.isArray(rawMasks)) return [];
  const masks: ClipItem['masks'] = [];

  for (const raw of rawMasks) {
    if (!raw || typeof raw !== 'object') continue;
    const keyframes: ClipItem['masks'][number]['keyframes'] = [];
    for (const rawKf of raw.keyframes ?? []) {
      if (!rawKf || typeof rawKf !== 'object') continue;
      const points = (rawKf.points ?? [])
        .map((p) => {
          if (!p || typeof p !== 'object') return null;
          const x = typeof p.x === 'number' ? p.x : 0;
          const y = typeof p.y === 'number' ? p.y : 0;
          return {
            x,
            y,
            inX: typeof p.inX === 'number' ? p.inX : x,
            inY: typeof p.inY === 'number' ? p.inY : y,
            outX: typeof p.outX === 'number' ? p.outX : x,
            outY: typeof p.outY === 'number' ? p.outY : y,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p != null);

      keyframes.push({
        id:
          typeof rawKf.id === 'string' && rawKf.id.length > 0
            ? rawKf.id
            : nanoid(12),
        frame: Math.max(0, Math.round(typeof rawKf.frame === 'number' ? rawKf.frame : 0)),
        points,
      });
    }
    keyframes.sort((a, b) => a.frame - b.frame);

    masks.push({
      id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : nanoid(12),
      name: typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name : 'Mask',
      mode: raw.mode === 'subtract' || raw.mode === 'intersect' ? raw.mode : 'add',
      closed: raw.closed !== false,
      invert: raw.invert === true,
      opacity: clamp01(typeof raw.opacity === 'number' ? raw.opacity : 1),
      feather: Math.max(0, typeof raw.feather === 'number' ? raw.feather : 0),
      expansion: typeof raw.expansion === 'number' ? raw.expansion : 0,
      keyframes,
    });
  }

  return masks;
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
      masks: adaptStoredMasks(clip.masks),
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

function resolveFadeBlackOverlayOpacity(
  type: string | null,
  progress: number | null,
  phase: 'in' | 'out' | null,
): number {
  if (type !== 'fade-black' || progress == null || !phase) return 0;
  const t = clamp01(progress);
  return phase === 'in' ? 1 - t : t;
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

async function resolveMediaInputs(sequence: Sequence): Promise<ResolvedMediaInputs> {
  const db = getDb();
  const assetIds = new Set<string>();

  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaAssetId) assetIds.add(clip.mediaAssetId);
    }
  }

  const pathById = new Map<string, string>();
  const dimensionsById = new Map<string, MediaDimensions>();
  for (const assetId of assetIds) {
    const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).get();
    if (row && fs.existsSync(row.filePath)) {
      pathById.set(assetId, row.filePath);
      if (typeof row.width === 'number' && row.width > 0 && typeof row.height === 'number' && row.height > 0) {
        dimensionsById.set(assetId, {
          width: row.width,
          height: row.height,
        });
      }
    }
  }

  return { pathById, dimensionsById };
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


