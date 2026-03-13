/**
 * HTTP API client for communicating with the LocalCut backend server.
 */

const BASE_URL = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers as HeadersInit | undefined);
  const hasBody = options.body != null;
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (hasBody && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ApiProject {
  id: string;
  name: string;
  projectDir: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  sequences?: ApiSequence[];
}

export interface ApiSequence {
  id: string;
  projectId: string;
  name: string;
  frameRate: { num: number; den: number };
  resolution: { width: number; height: number };
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ApiMediaAsset {
  id: string;
  projectId: string;
  name: string;
  type: 'video' | 'audio' | 'image';
  filePath: string;
  mimeType: string | null;
  fileSize: number | null;
  duration: number | null;
  frameRate: { num: number; den: number } | null;
  resolution: { width: number; height: number } | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  codec: string | null;
  importedAt: string;
  thumbnailPath: string | null;
  waveformDataPath: string | null;
  proxy: { path: string; status: string } | null;
  metadata: Record<string, unknown>;
}

export interface ApiMediaDedupeResult {
  totalAssets: number;
  canonicalAssets: number;
  dedupedAssets: number;
  updatedSequences: number;
  removedFiles: number;
}

export interface ApiJob {
  id: string;
  projectId: string;
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  params: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExportStartParams {
  sequenceId: string;
  outputDir?: string;
  filename?: string;
  format?: 'mp4' | 'mov' | 'webm' | 'mkv';
  videoCodec?: 'libx264' | 'libx265' | 'libvpx-vp9' | 'copy';
  audioCodec?: 'aac' | 'libopus' | 'pcm_s16le' | 'copy';
  width?: number;
  height?: number;
  crf?: number;
  preset?: string;
  audioBitrate?: string;
  audioSampleRate?: number;
}

export interface ApiExportJob {
  id: string;
  status: string;
  progress: number;
  outputPath: string | null;
  error: string | null;
}

export interface ApiExportPreset {
  name: string;
  format: string;
  videoCodec: string;
  audioCodec: string;
  crf?: number;
  preset?: string;
  audioBitrate?: string;
  audioSampleRate?: number;
}

export const api = {
  projects: {
    list: () => request<{ success: boolean; data: ApiProject[] }>('/projects').then((r) => r.data),

    get: (id: string) =>
      request<{ success: boolean; data: ApiProject }>(`/projects/${id}`).then((r) => r.data),

    create: (name: string, settings?: Record<string, unknown>) =>
      request<{ success: boolean; data: ApiProject }>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name, settings }),
      }).then((r) => r.data),

    update: (id: string, body: { name?: string; settings?: Record<string, unknown> }) =>
      request<{ success: boolean; data: ApiProject }>(`/projects/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }).then((r) => r.data),

    delete: (id: string) => request<{ success: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  },

  media: {
    list: (projectId: string) =>
      request<{ success: boolean; data: ApiMediaAsset[] }>(`/projects/${projectId}/media`).then(
        (r) => r.data,
      ),

    import: (projectId: string, filePaths: string[]) =>
      request<{ success: boolean; data: { imported: ApiMediaAsset[]; errors: unknown[] } }>(
        `/projects/${projectId}/media/import`,
        { method: 'POST', body: JSON.stringify({ filePaths }) },
      ).then((r) => r.data),

    pick: (projectId: string) =>
      request<{ success: boolean; data: { imported: ApiMediaAsset[]; errors: { path: string; error: string }[] } }>(
        `/projects/${projectId}/media/pick`,
        { method: 'POST' },
      ).then((r) => r.data),

    /** Upload files via multipart form-data (native file picker / drag-and-drop). */
    upload: async (
      projectId: string,
      files: FileList | File[],
    ): Promise<{ imported: ApiMediaAsset[]; errors: { name: string; error: string }[] }> => {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file, file.name);
      }

      const res = await fetch(`${BASE_URL}/projects/${projectId}/media/upload`, {
        method: 'POST',
        body: formData,
        // Note: do NOT set Content-Type header — browser sets it with boundary
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const json = (await res.json()) as {
        success: boolean;
        data: { imported: ApiMediaAsset[]; errors: { name: string; error: string }[] };
      };
      return json.data;
    },

    get: (projectId: string, assetId: string) =>
      request<{ success: boolean; data: ApiMediaAsset }>(
        `/projects/${projectId}/media/${assetId}`,
      ).then((r) => r.data),

    delete: (projectId: string, assetId: string) =>
      request<{ success: boolean }>(`/projects/${projectId}/media/${assetId}`, {
        method: 'DELETE',
      }),

    dedupe: (projectId: string) =>
      request<{ success: boolean; data: ApiMediaDedupeResult }>(
        `/projects/${projectId}/media/dedupe`,
        { method: 'POST' },
      ).then((r) => r.data),

    /** URL for streaming a media file with Range support. */
    fileUrl: (assetId: string) => `/api/media-file/${assetId}`,

    /** Fetch waveform peak data for a media asset. */
    waveform: (assetId: string, samples = 800) =>
      request<{
        success: boolean;
        data: { peaks: number[]; sampleRate: number; duration: number };
      }>(`/media-file/${assetId}/waveform?samples=${samples}`).then((r) => r.data),
  },

  sequences: {
    get: (id: string) =>
      request<{ success: boolean; data: ApiSequence }>(`/sequences/${id}`).then((r) => r.data),

    update: (
      id: string,
      body: {
        name?: string;
        data?: Record<string, unknown>;
        frameRate?: { num: number; den: number };
        resolution?: { width: number; height: number };
      },
    ) =>
      request<{ success: boolean; data: ApiSequence }>(`/sequences/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }).then((r) => r.data),
  },

  jobs: {
    get: (id: string) =>
      request<{ success: boolean; data: ApiJob }>(`/jobs/${id}`).then((r) => r.data),

    list: (projectId?: string) => {
      const qs = projectId ? `?projectId=${projectId}` : '';
      return request<{ success: boolean; data: ApiJob[] }>(`/jobs${qs}`).then((r) => r.data);
    },

    delete: (id: string) => request<{ success: boolean }>(`/jobs/${id}`, { method: 'DELETE' }),
  },

  export: {
    start: (params: ExportStartParams) =>
      request<{ success: boolean; data: ApiExportJob }>('/export', {
        method: 'POST',
        body: JSON.stringify(params),
      }).then((r) => r.data),

    cancel: (jobId: string) =>
      request<{ success: boolean }>(`/export/${jobId}/cancel`, { method: 'POST' }),

    presets: () =>
      request<{ success: boolean; data: ApiExportPreset[] }>('/export/presets').then((r) => r.data),
  },

  health: () => request<{ status: string; version: string }>('/health'),
};
