/** Standard API response wrapper */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Paginated response */
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  offset: number;
  limit: number;
}

/** WebSocket message envelope */
export interface WSMessage<T = unknown> {
  type: string;
  payload: T;
  timestamp: number;
}

/** Job progress WebSocket message */
export interface JobProgressPayload {
  jobId: string;
  status: import('./job.js').JobStatus;
  progress: number;
  message?: string;
}

/** Playback sync WebSocket message */
export interface PlaybackSyncPayload {
  sequenceId: string;
  currentFrame: number;
  isPlaying: boolean;
  timestamp: number;
}

/** Media event WebSocket messages */
export interface MediaImportedPayload {
  mediaAssetId: string;
}

export interface ProxyReadyPayload {
  mediaAssetId: string;
  proxyPath: string;
}

export interface WaveformReadyPayload {
  mediaAssetId: string;
}
