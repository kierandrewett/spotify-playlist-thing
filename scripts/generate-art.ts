/**
 * Generate playlist cover art.
 *
 * Builds a 2×2 grid (or 1-up / 2-up if the playlist has fewer unique albums)
 * from the playlist's tracks, composites a dark gradient + bold playlist name
 * across the bottom, encodes as JPEG (<256KB), uploads to Spotify.
 *
 * Usage:
 *   pnpm art                        # generate everything not already cached
 *   pnpm art --force                # regenerate all 27, even cached
 *   pnpm art --only "Deep Focus"    # one playlist
 */

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import sharp from 'sharp';

import { openDb } from '../src/state.js';
import { loadTaxonomy } from '../src/taxonomy.js';
import {
  createSpotifyClient,
  uploadPlaylistImage,
  type SpotifyClient,
} from '../src/spotify.js';
import { getPlaylistMapping } from '../src/state.js';

// ── Config ────────────────────────────────────────────────────────────────────

const ART_DIR = './art';
const FINAL_SIZE = 1024;
const HALF = FINAL_SIZE / 2;
const MAX_TRACKS_TO_FETCH = 12; // we look at 12 most-recent classifications to find 4 distinct albums
const SPOTIFY_IMAGE_BUDGET = 256_000; // bytes — Spotify's cap on the base64 string

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY_IDX = args.indexOf('--only');
const ONLY: string | null = ONLY_IDX >= 0 ? args[ONLY_IDX + 1] ?? null : null;

// ── Spotify access-token plumbing for raw image downloads ─────────────────────

interface TrackResp {
  id: string;
  album?: {
    id: string;
    images?: Array<{ url: string; width: number; height: number }>;
  };
}

async function fetchTracksBatch(
  client: SpotifyClient,
  ids: string[],
): Promise<TrackResp[]> {
  if (ids.length === 0) return [];
  // Reach into the client's internal access token. Justified: this script
  // does many small reads and we'd otherwise add a dedicated batch endpoint
  // to spotify.ts solely for art-gen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (client as unknown as { _internal: { accessToken: string } })._internal;
  const out: TrackResp[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = `https://api.spotify.com/v1/tracks?ids=${batch.join(',')}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`getTracksBatch HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { tracks: Array<TrackResp | null> };
    for (const t of data.tracks) if (t) out.push(t);
  }
  return out;
}

// ── DB query: most-recent classified tracks per playlist ──────────────────────

function recentTracksForPlaylist(db: Database, playlistName: string): string[] {
  const stmt = db.prepare<[string], { spotify_id: string }>(`
    SELECT c.spotify_id
    FROM classifications c
    JOIN tracks t ON c.spotify_id = t.spotify_id
    WHERE c.playlist_name = ? AND t.removed_at IS NULL
    ORDER BY t.added_at DESC
    LIMIT ${MAX_TRACKS_TO_FETCH}
  `);
  return stmt.all(playlistName).map((r) => r.spotify_id);
}

// ── Image fetching ────────────────────────────────────────────────────────────

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Composition ───────────────────────────────────────────────────────────────

interface Cell {
  buf: Buffer;
  width: number;
  height: number;
  left: number;
  top: number;
}

/** Fixed 2×2 layout. Caller guarantees exactly 4 unique album images. */
const GRID_LAYOUT: Array<{ width: number; height: number; left: number; top: number }> = [
  { width: HALF, height: HALF, left: 0, top: 0 },
  { width: HALF, height: HALF, left: HALF, top: 0 },
  { width: HALF, height: HALF, left: 0, top: HALF },
  { width: HALF, height: HALF, left: HALF, top: HALF },
];

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '&' ? '&amp;'
    : c === "'" ? '&apos;'
    : '&quot;'
  );
}

function overlaySvg(name: string): Buffer {
  // Auto-shrink long names. Eyeballed for ~1024px.
  const fontSize = name.length > 16 ? 60 : name.length > 12 ? 76 : 92;
  const safe = escapeXml(name);
  const svg = `
<svg width="${FINAL_SIZE}" height="${FINAL_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0.55" x2="0" y2="1">
      <stop offset="0%" stop-color="black" stop-opacity="0"/>
      <stop offset="60%" stop-color="black" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.95"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${FINAL_SIZE * 0.45}" width="${FINAL_SIZE}" height="${FINAL_SIZE * 0.55}" fill="url(#g)"/>
  <text x="48" y="${FINAL_SIZE - 56}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
        font-weight="900" font-size="${fontSize}" fill="white"
        style="paint-order: stroke; stroke: rgba(0,0,0,0.4); stroke-width: 2">${safe}</text>
</svg>`.trim();
  return Buffer.from(svg);
}

async function composeArt(name: string, imageBuffers: Buffer[]): Promise<Buffer> {
  if (imageBuffers.length !== 4) {
    throw new Error(`composeArt requires exactly 4 images for "${name}", got ${imageBuffers.length}`);
  }

  // Resize each image to its slot using cover crop.
  const cells: Cell[] = [];
  for (let i = 0; i < GRID_LAYOUT.length; i++) {
    const slot = GRID_LAYOUT[i];
    const resized = await sharp(imageBuffers[i])
      .resize(slot.width, slot.height, { fit: 'cover', position: 'centre' })
      .toBuffer();
    cells.push({ buf: resized, ...slot });
  }

  // Composite onto a black canvas.
  const base = sharp({
    create: {
      width: FINAL_SIZE,
      height: FINAL_SIZE,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  });

  const composited = await base
    .composite([
      ...cells.map((c) => ({ input: c.buf, left: c.left, top: c.top })),
      { input: overlaySvg(name), left: 0, top: 0 },
    ])
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  // Spotify's cap is 256KB on the base64 string. Base64 inflates by ~33%, so
  // the binary JPEG must be under ~190KB. Step quality down if we overshoot.
  let quality = 85;
  let buf = composited;
  while (Buffer.byteLength(buf.toString('base64'), 'utf8') > SPOTIFY_IMAGE_BUDGET && quality > 40) {
    quality -= 10;
    buf = await sharp(composited).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  return buf;
}

// ── Per-playlist runner ───────────────────────────────────────────────────────

interface ProcessResult {
  name: string;
  status: 'generated' | 'reuploaded' | 'skipped-not-ready' | 'skipped-no-mapping' | 'error';
  message?: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function processPlaylist(
  name: string,
  db: Database,
  spotify: SpotifyClient,
  trackById: Map<string, TrackResp>,
): Promise<ProcessResult> {
  const cachePath = join(ART_DIR, `${slugify(name)}.jpg`);

  const playlistId = getPlaylistMapping(db, name);
  if (!playlistId) {
    return { name, status: 'skipped-no-mapping', message: 'no Spotify playlist id in state DB — run sync first' };
  }

  // Cache check: if a JPEG already exists and we're not in --force mode, just
  // re-upload it. We can't tell from disk alone whether the previous upload
  // actually succeeded (e.g. earlier runs without ugc-image-upload scope wrote
  // the file but the upload 403'd). Re-uploading is idempotent on Spotify's
  // side and cheap, so always do it.
  let jpeg: Buffer;
  let regenerated: boolean;

  if (!FORCE && existsSync(cachePath)) {
    jpeg = await readFile(cachePath);
    regenerated = false;
  } else {
    const trackIds = recentTracksForPlaylist(db, name);

    const seenAlbums = new Set<string>();
    const uniqueImageUrls: string[] = [];
    for (const id of trackIds) {
      const t = trackById.get(id);
      if (!t?.album?.id || !t.album.images || t.album.images.length === 0) continue;
      if (seenAlbums.has(t.album.id)) continue;
      seenAlbums.add(t.album.id);
      uniqueImageUrls.push(t.album.images[0].url);
      if (uniqueImageUrls.length === 4) break;
    }

    if (uniqueImageUrls.length < 4) {
      return {
        name,
        status: 'skipped-not-ready',
        message: `${uniqueImageUrls.length}/4 distinct albums (need 4)`,
      };
    }

    const buffers = await Promise.all(uniqueImageUrls.map(downloadImage));
    jpeg = await composeArt(name, buffers);

    await mkdir(ART_DIR, { recursive: true });
    await writeFile(cachePath, jpeg);
    regenerated = true;
  }

  await uploadPlaylistImage(spotify, playlistId, jpeg.toString('base64'));

  return regenerated
    ? { name, status: 'generated', message: `${jpeg.length}B jpeg` }
    : { name, status: 'reuploaded', message: `from cache, ${jpeg.length}B` };
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const required = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`missing env: ${missing.join(', ')} — see .env.example`);
    process.exit(1);
  }

  const taxonomy = loadTaxonomy('./taxonomy.yaml');
  const db = openDb('./state.sqlite');
  const spotify = await createSpotifyClient({
    clientId: process.env['SPOTIFY_CLIENT_ID']!,
    clientSecret: process.env['SPOTIFY_CLIENT_SECRET']!,
    refreshToken: process.env['SPOTIFY_REFRESH_TOKEN']!,
  });

  const targets = ONLY
    ? taxonomy.playlists.filter((p) => p.name === ONLY)
    : taxonomy.playlists;
  if (targets.length === 0) {
    console.error(ONLY ? `no taxonomy entry named "${ONLY}"` : 'no taxonomy entries');
    process.exit(1);
  }

  // Pre-collect every track ID we'll need across all playlists, so we batch
  // the Spotify GET /tracks calls once instead of N×.
  const allTrackIds = new Set<string>();
  for (const entry of targets) {
    for (const id of recentTracksForPlaylist(db, entry.name)) allTrackIds.add(id);
  }
  console.error(`[art] resolving album images for ${allTrackIds.size} tracks…`);
  const tracks = await fetchTracksBatch(spotify, [...allTrackIds]);
  const trackById = new Map(tracks.map((t) => [t.id, t]));

  // Process playlists with bounded concurrency so we don't hammer Spotify
  // image upload (the heaviest call).
  const POOL = 3;
  const queue = [...targets];
  const results: ProcessResult[] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        const r = await processPlaylist(entry.name, db, spotify, trackById);
        results.push(r);
        const tag = r.status === 'generated' ? '✓'
          : r.status === 'reuploaded' ? '↑'
          : r.status === 'error' ? '✗'
          : '⏳';
        console.error(`[art] ${tag} ${entry.name}${r.message ? ` — ${r.message}` : ''}`);
      } catch (err) {
        results.push({ name: entry.name, status: 'error', message: String(err) });
        console.error(`[art] ✗ ${entry.name} — ${String(err)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: POOL }, worker));

  // Summary
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.error(`\n[art] done: ${JSON.stringify(counts)}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
