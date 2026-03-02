import type { ID } from './project.js';

export interface MaskAsset {
  id: ID;
  clipId: ID;
  label: string; // e.g. "Person", "Background"
  type: 'sam3' | 'manual';
  dataPath: string; // Path to mask data (frame-indexed alpha maps)
  frameRange: {
    start: number;
    end: number;
  };
  tracked: boolean; // Whether mask is tracked across frames
}

/** Request to segment an object in a video frame */
export interface SegmentRequest {
  mediaAssetId: ID;
  frameNumber: number;
  prompt: string; // Text prompt for SAM concept segmentation
  points?: { x: number; y: number; label: 0 | 1 }[]; // Click prompts
  box?: { x1: number; y1: number; x2: number; y2: number };
}

export interface SegmentResponse {
  masks: Array<{
    maskData: string; // Base64 encoded mask image
    score: number;
    label: string;
  }>;
}

export interface UpscaleRequest {
  mediaAssetId: ID;
  scaleFactor: 2 | 4;
  model: 'realesrgan-x4plus' | 'realesrgan-x4plus-anime';
}

export interface InterpolationRequest {
  mediaAssetId: ID;
  factor: 2 | 4 | 8; // 2x = double frame rate, etc.
  model: 'rife-v4.25';
}

export interface TranscribeRequest {
  mediaAssetId: ID;
  language?: string; // ISO 639-1 code, or 'auto'
  model: 'whisper-large-v3' | 'whisper-medium' | 'whisper-small';
}

export interface TranscribeResponse {
  segments: Array<{
    start: number; // seconds
    end: number;
    text: string;
    confidence: number;
  }>;
  fullText: string;
  language: string;
}

export interface LLMEditRequest {
  sequenceId: ID;
  instruction: string; // Natural language editing instruction
  context: {
    clipDescriptions: Array<{ clipId: ID; description: string }>;
    transcription?: string;
  };
}

export interface LLMEditResponse {
  suggestedEdits: Array<{
    action: 'cut' | 'move' | 'delete' | 'trim' | 'insert';
    clipId?: ID;
    params: Record<string, unknown>;
    explanation: string;
  }>;
}
