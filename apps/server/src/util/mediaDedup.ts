import path from 'path';

export interface MediaDedupeMetadata {
  sourceKind?: 'import' | 'upload' | 'unknown';
  normalizedPath?: string;
  contentHash?: string;
}

export interface ParsedMediaMetadata extends Record<string, unknown> {
  dedupe?: MediaDedupeMetadata;
}

export interface MediaLikeRow {
  id: string;
  filePath: string;
  importedAt?: string | null;
  metadata?: string | null;
}

export function normalizeMediaPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const normalized = path.normalize(resolved);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function parseMediaMetadata(raw: string | null | undefined): ParsedMediaMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ParsedMediaMetadata;
  } catch {
    return {};
  }
}

export function serializeMediaMetadata(metadata: ParsedMediaMetadata): string {
  return JSON.stringify(metadata ?? {});
}

export function mergeMediaDedupeMetadata(
  raw: string | null | undefined,
  patch: MediaDedupeMetadata,
): { metadata: ParsedMediaMetadata; changed: boolean } {
  const metadata = parseMediaMetadata(raw);
  const current = metadata.dedupe ?? {};
  const next: MediaDedupeMetadata = {
    sourceKind: patch.sourceKind ?? current.sourceKind,
    normalizedPath: patch.normalizedPath ?? current.normalizedPath,
    contentHash: patch.contentHash ?? current.contentHash,
  };
  const changed =
    next.sourceKind !== current.sourceKind ||
    next.normalizedPath !== current.normalizedPath ||
    next.contentHash !== current.contentHash;
  if (changed) {
    metadata.dedupe = next;
  }
  return { metadata, changed };
}

export function getMediaDedupeKey(
  row: Pick<MediaLikeRow, 'filePath' | 'metadata'>,
  options?: { contentHash?: string | null; normalizedPath?: string | null },
): string | null {
  const metadata = parseMediaMetadata(row.metadata);
  const contentHash = options?.contentHash ?? metadata.dedupe?.contentHash ?? null;
  if (contentHash) return `hash:${contentHash}`;
  const normalizedPath =
    options?.normalizedPath ?? metadata.dedupe?.normalizedPath ?? normalizeMediaPath(row.filePath);
  return normalizedPath ? `path:${normalizedPath}` : null;
}

export function collectSequenceMediaReferences(data: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!data || typeof data !== 'object') return counts;
  const tracks = Array.isArray((data as { tracks?: unknown[] }).tracks)
    ? ((data as { tracks?: unknown[] }).tracks as Array<{ clips?: unknown[] }>)
    : [];

  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) {
      if (!clip || typeof clip !== 'object') continue;
      const assetId = (clip as { mediaAssetId?: unknown }).mediaAssetId;
      if (typeof assetId !== 'string' || assetId.length === 0) continue;
      counts[assetId] = (counts[assetId] ?? 0) + 1;
    }
  }

  return counts;
}

export function remapSequenceMediaReferences(
  rawData: string,
  remap: Record<string, string>,
): { changed: boolean; data: string; references: Record<string, number> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData || '{}');
  } catch {
    return { changed: false, data: rawData, references: {} };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { changed: false, data: rawData, references: {} };
  }

  let changed = false;
  const root = parsed as { tracks?: Array<{ clips?: Array<Record<string, unknown>> }> };
  const tracks = Array.isArray(root.tracks) ? root.tracks : [];

  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) {
      const currentAssetId = typeof clip.mediaAssetId === 'string' ? clip.mediaAssetId : null;
      if (!currentAssetId) continue;
      const replacement = remap[currentAssetId];
      if (!replacement || replacement === currentAssetId) continue;
      clip.mediaAssetId = replacement;
      changed = true;
    }
  }

  const references = collectSequenceMediaReferences(parsed);
  return {
    changed,
    data: changed ? JSON.stringify(parsed) : rawData,
    references,
  };
}

export function chooseCanonicalMediaAsset<T extends Pick<MediaLikeRow, 'id' | 'importedAt'>>(
  rows: T[],
  referenceCounts: Record<string, number>,
): T {
  return [...rows].sort((left, right) => {
    const leftRefs = referenceCounts[left.id] ?? 0;
    const rightRefs = referenceCounts[right.id] ?? 0;
    if (leftRefs !== rightRefs) return rightRefs - leftRefs;
    const leftTime = left.importedAt ? Date.parse(left.importedAt) || 0 : 0;
    const rightTime = right.importedAt ? Date.parse(right.importedAt) || 0 : 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id.localeCompare(right.id);
  })[0]!;
}

