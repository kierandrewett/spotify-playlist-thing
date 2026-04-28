/**
 * MusicBrainz lookup by ISRC.
 *
 * Caching strategy: both 404 (not found) and found-but-no-tags results are
 * stored as {genres:[], tags:[]} in musicbrainz_cache. This prevents re-hitting
 * MB for known-missing ISRCs. Callers receive null only when there is no cache
 * entry AND the live lookup returns 404 — but after that first 404, subsequent
 * calls return {genres:[], tags:[]} from cache (not null). This is intentional:
 * once we know MB has nothing for an ISRC, we stop asking.
 *
 * API note: the /isrc/{isrc} endpoint only supports ?inc=tags, not ?inc=genres.
 * Genres are formal MB genre objects and must be fetched via the /recording/
 * endpoint for each recording returned. We fetch genres for each recording ID
 * individually (respecting the 1 req/s limit between calls) and aggregate them
 * alongside the tags already returned by the ISRC lookup.
 */

import type { Database } from 'better-sqlite3';
import type { MusicbrainzTags } from './types.js';
import { getMusicbrainzCache, setMusicbrainzCache } from './state.js';

const MB_BASE_URL = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1000; // MusicBrainz hard limit: 1 request per second

// ── Types for MusicBrainz API responses ───────────────────────────────────────

interface MbTagEntry {
  name: string;
  count: number;
}

/** Shape returned by GET /isrc/{isrc}?inc=tags */
interface MbIsrcResponse {
  isrc?: string;
  recordings?: Array<{
    id: string;
    title: string;
    tags?: MbTagEntry[];
  }>;
}

/** Shape returned by GET /recording/{id}?inc=genres+tags */
interface MbRecordingResponse {
  id: string;
  genres?: MbTagEntry[];
  tags?: MbTagEntry[];
}

// ── Client ─────────────────────────────────────────────────────────────────────

export interface MusicbrainzClient {
  contactEmail: string;
  /** Timestamp (ms) of the last outgoing request. 0 if none yet. */
  lastRequestAt: number;
}

export function createMusicbrainzClient(contactEmail: string): MusicbrainzClient {
  return { contactEmail, lastRequestAt: 0 };
}

// ── Throttle helper ────────────────────────────────────────────────────────────

/**
 * Sleep until at least MIN_INTERVAL_MS has elapsed since the last request, then
 * update `client.lastRequestAt`. Must be awaited before each fetch call.
 */
async function throttle(client: MusicbrainzClient): Promise<void> {
  const now = Date.now();
  const elapsed = now - client.lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, MIN_INTERVAL_MS - elapsed),
    );
  }
  client.lastRequestAt = Date.now();
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function mbFetch(
  client: MusicbrainzClient,
  path: string,
): Promise<{ status: number; body: unknown }> {
  await throttle(client);
  const url = `${MB_BASE_URL}/${path}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': `spotify-playlist-thing/1.0 (${client.contactEmail})`,
      Accept: 'application/json',
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `MusicBrainz request failed: HTTP ${response.status} for ${url}`,
    );
  }
  const body: unknown = response.status === 404 ? null : await response.json();
  return { status: response.status, body };
}

// ── Aggregation helper ─────────────────────────────────────────────────────────

/**
 * Aggregate tag/genre entries across multiple recordings: sum counts per name,
 * sort descending by total count, return top-20 deduplicated names.
 */
function aggregate(entries: MbTagEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const { name, count } of entries) {
    counts.set(name, (counts.get(name) ?? 0) + count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name]) => name);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Look up MusicBrainz genre/tag data for a given ISRC.
 *
 * Returns null if MusicBrainz has no recording for this ISRC (404 or empty
 * recordings list). Note: after the first 404, subsequent calls will return
 * {genres:[], tags:[]} (from cache) rather than null — see caching strategy.
 *
 * Returns {genres:[], tags:[]} if found but no genre/tag data exists.
 * Always reads/writes musicbrainz_cache keyed on ISRC.
 */
export async function lookupByIsrc(
  client: MusicbrainzClient,
  db: Database,
  isrc: string,
): Promise<MusicbrainzTags | null> {
  // Cache-first: return immediately if we have a stored result.
  const cached = getMusicbrainzCache(db, isrc);
  if (cached !== null) {
    return cached;
  }

  // Step 1: ISRC → recording IDs + tags (only ?inc=tags is valid here).
  const isrcResult = await mbFetch(
    client,
    `isrc/${encodeURIComponent(isrc)}?inc=tags&fmt=json`,
  );

  if (isrcResult.status === 404) {
    // Cache the empty sentinel so we don't retry on subsequent runs.
    const empty: MusicbrainzTags = { genres: [], tags: [] };
    setMusicbrainzCache(db, isrc, empty);
    return null;
  }

  const isrcBody = isrcResult.body as MbIsrcResponse;
  if (!isrcBody.recordings || isrcBody.recordings.length === 0) {
    const empty: MusicbrainzTags = { genres: [], tags: [] };
    setMusicbrainzCache(db, isrc, empty);
    return null;
  }

  // Collect tags from the ISRC response.
  const allTagEntries: MbTagEntry[] = [];
  for (const rec of isrcBody.recordings) {
    if (rec.tags) allTagEntries.push(...rec.tags);
  }

  // Step 2: Fetch genres for each recording via the recording endpoint.
  // The /isrc/ endpoint does not support ?inc=genres — genres must be
  // retrieved separately per recording.
  const allGenreEntries: MbTagEntry[] = [];
  for (const rec of isrcBody.recordings) {
    const recResult = await mbFetch(
      client,
      `recording/${encodeURIComponent(rec.id)}?inc=genres&fmt=json`,
    );
    if (recResult.status !== 404 && recResult.body !== null) {
      const recBody = recResult.body as MbRecordingResponse;
      if (recBody.genres) allGenreEntries.push(...recBody.genres);
    }
  }

  const result: MusicbrainzTags = {
    genres: aggregate(allGenreEntries),
    tags: aggregate(allTagEntries),
  };

  setMusicbrainzCache(db, isrc, result);
  return result;
}
