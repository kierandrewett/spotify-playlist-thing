/**
 * Spotify Web API client.
 *
 * Uses the February 2026 endpoints:
 *   POST   /playlists/{id}/items   (add tracks)
 *   DELETE /playlists/{id}/items   (remove tracks)
 *   GET    /me/tracks              (liked songs — read endpoint unchanged)
 */

import { SpotifyTrack, SpotifyArtistRef, SpotifyArtist } from './types.js';

// ---------------------------------------------------------------------------
// Internal narrow types for Spotify JSON responses
// ---------------------------------------------------------------------------

interface SpotifyTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

interface SpotifyPagingObject<T> {
  items: T[];
  next: string | null;
  total: number;
}

interface SpotifySavedTrackObject {
  added_at: string;
  track: SpotifyTrackObject;
}

interface SpotifyTrackObject {
  id: string;
  uri: string;
  name: string;
  artists: SpotifyArtistRefObject[];
  album: SpotifyAlbumObject;
  external_ids?: { isrc?: string };
  preview_url: string | null;
}

interface SpotifyArtistRefObject {
  id: string;
  name: string;
}

interface SpotifyAlbumObject {
  id: string;
  name: string;
  release_date: string;
}

interface SpotifyArtistObject {
  id: string;
  name: string;
  genres: string[];
}

interface SpotifyArtistsResponse {
  artists: (SpotifyArtistObject | null)[];
}

interface SpotifyPlaylistObject {
  id: string;
  name: string;
}

interface SpotifyUserProfile {
  id: string;
}

interface SpotifyCreatePlaylistBody {
  name: string;
  public: boolean;
  description: string;
}

// ---------------------------------------------------------------------------
// SpotifyClient interface and internal state
// ---------------------------------------------------------------------------

export interface SpotifyClient {
  /** Opaque — do not use directly. Prefer the exported helper functions. */
  readonly _internal: SpotifyClientState;
}

interface SpotifyClientState {
  accessToken: string;
  expiresAt: number; // Unix ms
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function refreshTokens(state: SpotifyClientState): Promise<void> {
  const credentials = Buffer.from(`${state.clientId}:${state.clientSecret}`).toString('base64');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Token refresh failed: POST /api/token → ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as SpotifyTokenResponse;
  state.accessToken = data.access_token;
  state.expiresAt = Date.now() + data.expires_in * 1000;
  // Spotify may rotate the refresh token; adopt the new one if present.
  if (data.refresh_token) {
    state.refreshToken = data.refresh_token;
  }
}

function isTokenStale(state: SpotifyClientState): boolean {
  // Refresh if token expires within 60 seconds.
  return Date.now() >= state.expiresAt - 60_000;
}

async function ensureFreshToken(state: SpotifyClientState): Promise<void> {
  if (isTokenStale(state)) {
    await refreshTokens(state);
  }
}

// ---------------------------------------------------------------------------
// Low-level HTTP helper
// ---------------------------------------------------------------------------

/** HTTP statuses that mean "Spotify is having a moment, try again". */
const SPOTIFY_TRANSIENT_STATUSES = new Set([502, 503, 504]);
const SPOTIFY_MAX_ATTEMPTS = 4;

async function spotifyFetch(
  state: SpotifyClientState,
  url: string,
  options: RequestInit = {},
  attempt = 1,
  refreshedOnce = false,
): Promise<Response> {
  await ensureFreshToken(state);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.accessToken}`,
    ...(options.headers as Record<string, string> | undefined),
  };

  let res: Response;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (err) {
    // Network-level failure (TypeError, ECONNRESET, etc.) — retry with backoff.
    const isNetworkError =
      err instanceof TypeError ||
      (err instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(err.message));
    if (isNetworkError && attempt < SPOTIFY_MAX_ATTEMPTS) {
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.error(
        `[spotify] network error on ${options.method ?? 'GET'} ${new URL(url).pathname}, retrying in ${backoffMs}ms (attempt ${attempt}/${SPOTIFY_MAX_ATTEMPTS - 1}): ${String(err)}`,
      );
      await sleep(backoffMs);
      return spotifyFetch(state, url, options, attempt + 1, refreshedOnce);
    }
    throw err;
  }

  if (res.status === 401 && !refreshedOnce) {
    // Force a token refresh and retry once.
    await refreshTokens(state);
    return spotifyFetch(state, url, options, attempt, true);
  }

  if (res.status === 429 && attempt < SPOTIFY_MAX_ATTEMPTS) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
    await sleep(retryAfter * 1000);
    return spotifyFetch(state, url, options, attempt + 1, refreshedOnce);
  }

  if (SPOTIFY_TRANSIENT_STATUSES.has(res.status) && attempt < SPOTIFY_MAX_ATTEMPTS) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
    console.error(
      `[spotify] transient ${res.status} on ${options.method ?? 'GET'} ${new URL(url).pathname}, retrying in ${backoffMs}ms (attempt ${attempt}/${SPOTIFY_MAX_ATTEMPTS - 1})`,
    );
    await sleep(backoffMs);
    return spotifyFetch(state, url, options, attempt + 1, refreshedOnce);
  }

  if (!res.ok) {
    const body = await res.text();
    const endpoint = new URL(url).pathname;
    throw new Error(
      `Spotify API error: ${options.method ?? 'GET'} ${endpoint} → ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
    );
  }

  return res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export async function createSpotifyClient(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<SpotifyClient> {
  const state: SpotifyClientState = {
    accessToken: '',
    expiresAt: 0,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    refreshToken: opts.refreshToken,
  };

  // Obtain a fresh access token immediately.
  await refreshTokens(state);

  return { _internal: state };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export async function getCurrentUserId(client: SpotifyClient): Promise<string> {
  const state = client._internal;
  const res = await spotifyFetch(state, 'https://api.spotify.com/v1/me');
  const data = (await res.json()) as SpotifyUserProfile;
  return data.id;
}

export async function getLikedTracks(client: SpotifyClient): Promise<SpotifyTrack[]> {
  const state = client._internal;
  const tracks: SpotifyTrack[] = [];
  let url: string | null =
    'https://api.spotify.com/v1/me/tracks?limit=50&offset=0';

  while (url !== null) {
    const res = await spotifyFetch(state, url);
    const page = (await res.json()) as SpotifyPagingObject<SpotifySavedTrackObject>;

    for (const item of page.items) {
      const t = item.track;
      const artists: SpotifyArtistRef[] = t.artists.map((a) => ({
        id: a.id,
        name: a.name,
      }));

      tracks.push({
        id: t.id,
        uri: t.uri,
        name: t.name,
        artists,
        album: {
          id: t.album.id,
          name: t.album.name,
          release_date: t.album.release_date,
        },
        isrc: t.external_ids?.isrc ?? null,
        preview_url: t.preview_url,
        added_at: item.added_at,
      });
    }

    url = page.next;
  }

  return tracks;
}

export async function getArtists(
  client: SpotifyClient,
  ids: string[],
): Promise<SpotifyArtist[]> {
  if (ids.length === 0) return [];

  const state = client._internal;
  const results: SpotifyArtist[] = [];

  for (const batch of chunk(ids, 50)) {
    const url = `https://api.spotify.com/v1/artists?ids=${batch.join(',')}`;
    const res = await spotifyFetch(state, url);
    const data = (await res.json()) as SpotifyArtistsResponse;

    for (const artist of data.artists) {
      if (artist !== null) {
        results.push({
          id: artist.id,
          name: artist.name,
          genres: artist.genres,
        });
      }
    }
  }

  return results;
}

/**
 * List EVERY playlist the user owns/follows. Paginates through `/me/playlists`
 * until exhausted. Use this once per sync instead of paginating per-name —
 * each call is N pages of API requests.
 */
export async function listUserPlaylists(
  client: SpotifyClient,
): Promise<Array<{ id: string; name: string }>> {
  const state = client._internal;
  let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50';
  const out: Array<{ id: string; name: string }> = [];
  while (url !== null) {
    const res = await spotifyFetch(state, url);
    const page = (await res.json()) as SpotifyPagingObject<SpotifyPlaylistObject>;
    for (const p of page.items) out.push({ id: p.id, name: p.name });
    url = page.next;
  }
  return out;
}

/** Create a new private playlist owned by the current user. */
export async function createPrivatePlaylist(
  client: SpotifyClient,
  name: string,
): Promise<string> {
  const state = client._internal;
  const userId = await getCurrentUserId(client);
  const res = await spotifyFetch(
    state,
    `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        public: false,
        description: 'Auto-managed by spotify-playlist-thing',
      } satisfies SpotifyCreatePlaylistBody),
    },
  );
  const data = (await res.json()) as SpotifyPlaylistObject;
  return data.id;
}

export async function getOrCreatePlaylist(
  client: SpotifyClient,
  name: string,
): Promise<string> {
  const state = client._internal;

  // Paginate through the user's playlists looking for an exact name match.
  let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50';

  while (url !== null) {
    const res = await spotifyFetch(state, url);
    const page = (await res.json()) as SpotifyPagingObject<SpotifyPlaylistObject>;

    for (const playlist of page.items) {
      if (playlist.name === name) {
        return playlist.id;
      }
    }

    url = page.next;
  }

  // Not found — create a private playlist.
  const userId = await getCurrentUserId(client);
  const body: SpotifyCreatePlaylistBody = {
    name,
    public: false,
    description: 'Auto-managed by spotify-playlist-thing',
  };

  const createRes = await spotifyFetch(
    state,
    `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  const created = (await createRes.json()) as SpotifyPlaylistObject;
  return created.id;
}

export async function addTracksToPlaylist(
  client: SpotifyClient,
  playlistId: string,
  uris: string[],
): Promise<void> {
  if (uris.length === 0) return;

  const state = client._internal;
  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`;

  for (const batch of chunk(uris, 100)) {
    await spotifyFetch(state, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: batch }),
    });
  }
}

export async function removeTracksFromPlaylist(
  client: SpotifyClient,
  playlistId: string,
  uris: string[],
): Promise<void> {
  if (uris.length === 0) return;

  const state = client._internal;
  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`;

  for (const batch of chunk(uris, 100)) {
    await spotifyFetch(state, url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      // Feb 2026 migration: the body parameter `tracks` was RENAMED to
      // `items`. The shape inside (objects with a `uri` key) is unchanged.
      // Spotify's "No uris provided" error message for missing `items` is
      // misleading; the actual field name comes from the migration guide.
      body: JSON.stringify({ items: batch.map((uri) => ({ uri })) }),
    });
  }
}

/**
 * Update a playlist's name and/or description. Only the fields you provide
 * are sent. Spotify caps description at ~300 characters; caller is
 * responsible for trimming.
 */
export async function updatePlaylistDetails(
  client: SpotifyClient,
  playlistId: string,
  fields: { name?: string; description?: string },
): Promise<void> {
  const state = client._internal;
  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`;
  await spotifyFetch(state, url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

/**
 * Replace a playlist's entire contents with the given ordered list of URIs.
 * Acts as both a reorder AND a dedupe: PUT /items wipes the existing list
 * and writes the first 100 in order; remaining items get appended via POST.
 * Pass an empty array to clear a playlist.
 */
export async function replacePlaylistItems(
  client: SpotifyClient,
  playlistId: string,
  uris: string[],
): Promise<void> {
  const state = client._internal;
  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`;

  // PUT replaces the playlist with the first batch (max 100).
  await spotifyFetch(state, url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });

  // Anything beyond the first 100 is appended in order via POST.
  if (uris.length > 100) {
    await addTracksToPlaylist(client, playlistId, uris.slice(100));
  }
}

/**
 * Fetch a single track and return the largest album image URL, or null if
 * the track has no album images.
 */
export async function getAlbumArtUrl(
  client: SpotifyClient,
  trackId: string,
): Promise<string | null> {
  const state = client._internal;
  const url = `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`;
  const body = await spotifyFetch(state, url);
  const images = (body as { album?: { images?: Array<{ url: string; width: number; height: number }> } }).album?.images;
  if (!images || images.length === 0) return null;
  // Spotify returns images sorted largest-first.
  return images[0].url;
}

/**
 * Upload a JPEG (provided as a base64 string, NO data URI prefix) as the
 * cover image for a playlist. Spotify enforces a 256KB max on the encoded
 * payload — caller is responsible for compressing.
 */
export async function uploadPlaylistImage(
  client: SpotifyClient,
  playlistId: string,
  jpegBase64: string,
): Promise<void> {
  const state = client._internal;
  await ensureFreshToken(state);
  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/images`;
  // Note: this endpoint takes the base64 string in the raw body with
  // Content-Type: image/jpeg, NOT a JSON wrapper. spotifyFetch's JSON
  // assumption doesn't fit, so call fetch directly.
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${state.accessToken}`,
      'Content-Type': 'image/jpeg',
    },
    body: jpegBase64,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`uploadPlaylistImage failed: HTTP ${response.status} for playlist ${playlistId}: ${text.slice(0, 200)}`);
  }
}
