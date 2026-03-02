import { nanoid } from 'nanoid';

/**
 * Generate a unique ID for entities.
 * Uses nanoid for URL-safe, compact IDs.
 */
export function generateId(): string {
  return nanoid(12);
}

/**
 * Generate a short ID (for display purposes).
 */
export function generateShortId(): string {
  return nanoid(8);
}
