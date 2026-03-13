import { describe, expect, it } from 'vitest';
import {
  chooseCanonicalMediaAsset,
  getMediaDedupeKey,
  mergeMediaDedupeMetadata,
  normalizeMediaPath,
  remapSequenceMediaReferences,
} from './mediaDedup.js';

describe('mediaDedup utilities', () => {
  it('normalizes media paths consistently', () => {
    const normalized = normalizeMediaPath('C:/Temp/../Temp/file.png');
    expect(normalized.endsWith('temp\\file.png') || normalized.endsWith('/Temp/file.png')).toBe(true);
  });

  it('prefers hash dedupe key over path dedupe key', () => {
    const key = getMediaDedupeKey(
      {
        filePath: 'D:/media/file.png',
        metadata: JSON.stringify({ dedupe: { normalizedPath: 'd:/media/file.png', contentHash: 'abc123' } }),
      },
    );
    expect(key).toBe('hash:abc123');
  });

  it('merges dedupe metadata without dropping existing values', () => {
    const result = mergeMediaDedupeMetadata(
      JSON.stringify({ note: 'keep-me', dedupe: { normalizedPath: 'a' } }),
      { contentHash: 'hash-1' },
    );
    expect(result.changed).toBe(true);
    expect(result.metadata.note).toBe('keep-me');
    expect(result.metadata.dedupe?.normalizedPath).toBe('a');
    expect(result.metadata.dedupe?.contentHash).toBe('hash-1');
  });

  it('remaps media asset references inside sequence data', () => {
    const source = JSON.stringify({
      tracks: [
        {
          clips: [
            { id: 'clip-1', mediaAssetId: 'dup-a' },
            { id: 'clip-2', mediaAssetId: 'keep-1' },
          ],
        },
        {
          clips: [
            { id: 'clip-3', mediaAssetId: 'dup-b' },
            { id: 'clip-4' },
          ],
        },
      ],
    });

    const result = remapSequenceMediaReferences(source, {
      'dup-a': 'canon-1',
      'dup-b': 'canon-1',
    });

    expect(result.changed).toBe(true);
    expect(result.references['canon-1']).toBe(2);
    expect(result.references['keep-1']).toBe(1);
    expect(result.data).toContain('"mediaAssetId":"canon-1"');
    expect(result.data).not.toContain('"mediaAssetId":"dup-a"');
  });

  it('chooses canonical asset by references, then oldest imported time', () => {
    const canonical = chooseCanonicalMediaAsset(
      [
        { id: 'a', importedAt: '2026-03-01T10:00:00.000Z' },
        { id: 'b', importedAt: '2026-03-01T09:00:00.000Z' },
        { id: 'c', importedAt: '2026-03-01T08:00:00.000Z' },
      ],
      { a: 1, b: 3, c: 3 },
    );

    expect(canonical.id).toBe('c');
  });
});

