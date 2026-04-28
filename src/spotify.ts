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

async function spotifyFetch(
  state: SpotifyClientState,
  url: string,
  options: RequestInit = {},
  retried = false,
): Promise<Response> {
  await ensureFreshToken(state);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.accessToken}`,
    ...(options.headers as Record<string, string> | undefined),
  };

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401 && !retried) {
    // Force a token refresh and retry once.
    await refreshTokens(state);
    return spotifyFetch(state, url, options, true);
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
    await sleep(retryAfter * 1000);
    if (!retried) {
      return spotifyFetch(state, url, options, true);
    }
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
      body: JSON.stringify({ tracks: batch.map((uri) => ({ uri })) }),
    });
  }
}
