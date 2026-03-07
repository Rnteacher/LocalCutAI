/**
 * FFprobe wrapper for extracting media metadata.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  duration: number | null;
  width: number | null;
  height: number | null;
  frameRateNum: number | null;
  frameRateDen: number | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  codec: string | null;
  mimeType: string;
}

/**
 * Probe a media file and return its metadata.
 */
export async function probeFile(filePath: string): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync(config.ffmpeg.ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const data = JSON.parse(stdout);
    const videoStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
    const audioStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio');
    const format = data.format || {};

    let frameRateNum: number | null = null;
    let frameRateDen: number | null = null;

    if (videoStream?.r_frame_rate) {
      const parts = videoStream.r_frame_rate.split('/');
      if (parts.length === 2) {
        frameRateNum = parseInt(parts[0], 10);
        frameRateDen = parseInt(parts[1], 10);
      }
    }

    // Determine MIME type from format name
    const formatName: string = format.format_name || '';
    let mimeType = 'application/octet-stream';
    if (formatName.includes('mp4') || formatName.includes('mov')) mimeType = 'video/mp4';
    else if (formatName.includes('webm')) mimeType = 'video/webm';
    else if (formatName.includes('avi')) mimeType = 'video/x-msvideo';
    else if (formatName.includes('matroska')) mimeType = 'video/x-matroska';
    else if (formatName.includes('wav')) mimeType = 'audio/wav';
    else if (formatName.includes('mp3')) mimeType = 'audio/mpeg';
    else if (formatName.includes('flac')) mimeType = 'audio/flac';
    else if (formatName.includes('aac')) mimeType = 'audio/aac';
    else if (formatName.includes('ogg')) mimeType = 'audio/ogg';
    else if (formatName.includes('image') || formatName.includes('png')) mimeType = 'image/png';
    else if (formatName.includes('jpeg') || formatName.includes('mjpeg')) mimeType = 'image/jpeg';

    return {
      duration: format.duration ? parseFloat(format.duration) : null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      frameRateNum,
      frameRateDen,
      audioChannels: audioStream?.channels ?? null,
      audioSampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : null,
      codec: videoStream?.codec_name ?? audioStream?.codec_name ?? null,
      mimeType,
    };
  } catch {
    // If ffprobe fails, return defaults
    return {
      duration: null,
      width: null,
      height: null,
      frameRateNum: null,
      frameRateDen: null,
      audioChannels: null,
      audioSampleRate: null,
      codec: null,
      mimeType: 'application/octet-stream',
    };
  }
}

/**
 * Determine the media type from a file extension.
 */
export function getMediaType(filePath: string): 'video' | 'audio' | 'image' {
  const ext = filePath.toLowerCase().split('.').pop() || '';
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'ts', 'mts', 'm4v'];
  const audioExts = ['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a', 'wma', 'aiff', 'opus'];
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'tif', 'webp', 'svg'];

  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (imageExts.includes(ext)) return 'image';
  return 'video'; // Default assumption
}
