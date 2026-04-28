/**
 * Last.fm tag fetcher.
 *
 * Fetches user-generated "vibe" tags (e.g. chill, melancholy, gym, driving)
 * from the Last.fm API. These are the primary free-text signal for the LLM
 * classifier.
 *
 * Cache strategy: reads/writes lastfm_cache keyed on Spotify track ID.
 * A cached empty array means "we already tried and got nothing" — we honour
 * that and do NOT re-fetch. Only a null from the cache triggers a fetch.
 */

import type { Database } from 'better-sqlite3';
import { getLastfmCache, setLastfmCache } from './state.js';
import type { LastfmTag } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const USER_AGENT = 'spotify-playlist-thing/1.0';
const MAX_TAGS = 10;
const MAX_WEIGHT = 100;

// ── Types ──────────────────────────────────────────────────────────────────────

/** Minimal shape of a single tag object in the Last.fm API response. */
interface RawTag {
  name: string;
  count: unknown;
  url: string;
}

/**
 * The `toptags` wrapper returned by both track.gettoptags and
 * artist.gettoptags. The `tag` field may be:
 *   - an array of tag objects (normal case)
 *   - a single tag object (when there is exactly one result)
 *   - an empty string "" or empty object when there are no results
 *
 * We use `unknown` here because Last.fm's response is underdefined in the
 * empty case, and we normalise it explicitly in `normaliseTags`.
 */
interface RawTopTags {
  toptags: {
    tag: unknown;
  };
}

/** Last.fm API error response shape (HTTP 200 with an error code). */
interface RawError {
  error: number;
  message: string;
}

// ── Client ─────────────────────────────────────────────────────────────────────

export interface LastfmClient {
  apiKey: string;
}

export function createLastfmClient(apiKey: string): LastfmClient {
  return { apiKey };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalise the `tag` field to an array regardless of what Last.fm returns.
 * Handles: array, single object, empty string, empty object, null/undefined.
 */
function normaliseTags(raw: RawTopTags): RawTag[] {
  const tag: unknown = raw.toptags.tag;
  if (!tag || tag === '') return [];
  if (Array.isArray(tag)) return tag as RawTag[];
  // Single-object case
  if (typeof tag === 'object' && tag !== null && 'name' in tag) {
    return [tag as RawTag];
  }
  return [];
}

/**
 * Convert a raw Last.fm tag to our `LastfmTag` shape.
 * Weight is capped at MAX_WEIGHT; missing count becomes 0.
 */
function toLastfmTag(raw: RawTag): LastfmTag {
  const count = typeof raw.count === 'number' ? raw.count : Number(raw.count);
  const weight = isNaN(count) ? 0 : Math.min(count, MAX_WEIGHT);
  return { name: raw.name, weight };
}

/**
 * Fetch a URL and parse the JSON response.
 * Throws on non-2xx HTTP status or Last.fm API-level errors.
 */
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(
      `Last.fm HTTP error: ${res.status} ${res.statusText} (url: ${url})`,
    );
  }

  const json = await res.json();

  // Last.fm returns HTTP 200 with {error, message} for API-level errors.
  if (
    json !== null &&
    typeof json === 'object' &&
    'error' in (json as object)
  ) {
    const err = json as RawError;
    throw new Error(`Last.fm API error ${err.error}: ${err.message}`);
  }

  return json;
}

/**
 * Build a Last.fm API URL with common query parameters.
 */
function buildUrl(
  apiKey: string,
  params: Record<string, string>,
): string {
  const qs = new URLSearchParams({ ...params, api_key: apiKey, format: 'json' });
  return `${LASTFM_BASE}?${qs.toString()}`;
}

/**
 * Fetch track top tags from Last.fm.
 * Returns an empty array if the track has no tags or if the API returns nothing.
 */
async function fetchTrackTags(
  client: LastfmClient,
  artist: string,
  track: string,
): Promise<LastfmTag[]> {
  const url = buildUrl(client.apiKey, {
    method: 'track.gettoptags',
    artist,
    track,
  });
  const json = await fetchJson(url);
  const raw = json as RawTopTags;
  const tags = normaliseTags(raw);
  return tags.slice(0, MAX_TAGS).map(toLastfmTag);
}

/**
 * Fetch artist top tags from Last.fm.
 * Returns an empty array if the artist has no tags or if the API returns nothing.
 */
async function fetchArtistTags(
  client: LastfmClient,
  artist: string,
): Promise<LastfmTag[]> {
  const url = buildUrl(client.apiKey, {
    method: 'artist.gettoptags',
    artist,
  });
  const json = await fetchJson(url);
  const raw = json as RawTopTags;
  const tags = normaliseTags(raw);
  return tags.slice(0, MAX_TAGS).map(toLastfmTag);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Return the top Last.fm tags for a (artist, track) pair.
 *
 * Strategy:
 *   1. Check the lastfm_cache table keyed on spotifyId. If a row exists,
 *      return the cached value even if it is an empty array (cached empty
 *      means "we already tried; there is nothing").
 *   2. Try track.gettoptags. If it yields tags, cache and return them.
 *   3. Fall back to artist.gettoptags. Cache and return whatever it yields
 *      (may be []).
 *
 * Throws on network/HTTP errors so the caller can decide how to handle them.
 */
export async function getTrackTags(
  client: LastfmClient,
  db: Database,
  spotifyId: string,
  artist: string,
  track: string,
): Promise<LastfmTag[]> {
  // 1. Cache hit
  const cached = getLastfmCache(db, spotifyId);
  if (cached !== null) return cached;

  // 2. Try track-level tags
  let tags = await fetchTrackTags(client, artist, track);

  // 3. Fall back to artist-level tags if the track had none
  if (tags.length === 0) {
    tags = await fetchArtistTags(client, artist);
  }

  // 4. Persist result (even if empty — records that we tried)
  setLastfmCache(db, spotifyId, tags);

  return tags;
}
