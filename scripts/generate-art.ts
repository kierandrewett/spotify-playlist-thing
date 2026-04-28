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
  updatePlaylistDetails,
  type SpotifyClient,
} from '../src/spotify.js';
import type { TaxonomyEntry } from '../src/types.js';
import { getPlaylistMapping } from '../src/state.js';

// ── Config ────────────────────────────────────────────────────────────────────

const ART_DIR = './art';
const CD_OVERLAY_PATH = './assets/cd_overlay.png';
const FONT_PATH = './assets/fonts/Inter-Black.ttf';
const FONT_FAMILY = 'Inter Black'; // matches the TTF's family/style name
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
  artists?: Array<{ name: string }>;
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

/**
 * Layout for N unique album images. Returns slot dimensions + position. Used
 * for the album-art grid behind the pill / CD overlay.
 *   1 → full bleed
 *   2 → top half / bottom half
 *   3 → top full-width band, two squares on the bottom
 *   4 → 2×2
 *   5+ → first 4 used as 2×2 (caller must trim)
 */
function layoutFor(n: number): Array<{ width: number; height: number; left: number; top: number }> {
  if (n >= 4) {
    return [
      { width: HALF, height: HALF, left: 0, top: 0 },
      { width: HALF, height: HALF, left: HALF, top: 0 },
      { width: HALF, height: HALF, left: 0, top: HALF },
      { width: HALF, height: HALF, left: HALF, top: HALF },
    ];
  }
  if (n === 3) {
    return [
      { width: FINAL_SIZE, height: HALF, left: 0, top: 0 },
      { width: HALF, height: HALF, left: 0, top: HALF },
      { width: HALF, height: HALF, left: HALF, top: HALF },
    ];
  }
  if (n === 2) {
    return [
      { width: FINAL_SIZE, height: HALF, left: 0, top: 0 },
      { width: FINAL_SIZE, height: HALF, left: 0, top: HALF },
    ];
  }
  return [{ width: FINAL_SIZE, height: FINAL_SIZE, left: 0, top: 0 }];
}

// Lazy-load the CD overlay PNG once, pre-resized to 1024×1024 so it's a
// drop-in for sharp.composite.
let _cdOverlayBuf: Buffer | null = null;
async function getCdOverlay(): Promise<Buffer> {
  if (_cdOverlayBuf) return _cdOverlayBuf;
  _cdOverlayBuf = await sharp(CD_OVERLAY_PATH)
    .resize(FINAL_SIZE, FINAL_SIZE, { fit: 'cover', position: 'centre' })
    .toBuffer();
  return _cdOverlayBuf;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '&' ? '&amp;'
    : c === "'" ? '&apos;'
    : '&quot;'
  );
}

/** WCAG relative luminance — used to pick black vs white text. */
function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Pick a vivid representative colour from an image. sharp's built-in
 * `.stats().dominant` averages everything (so red + green → muddy grey).
 * Instead we downsample, drop very dark / very light / desaturated pixels,
 * bucket the rest by hue, and return the centroid of the most-populous
 * bucket. Falls back to neutral grey if the whole image is achromatic.
 */
async function pickVividColour(buf: Buffer): Promise<{ r: number; g: number; b: number }> {
  const SAMPLE = 96;
  const HUE_BUCKETS = 12; // 30° each

  const { data } = await sharp(buf)
    .resize(SAMPLE, SAMPLE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ count: 0, r: 0, g: 0, b: 0 }));

  for (let i = 0; i < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 510; // 0..1
    if (lightness < 0.18 || lightness > 0.82) continue;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.45) continue;

    let hue = 0;
    const d = max - min;
    if (max === r) hue = ((g - b) / d + 6) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;

    const bucket = Math.floor(hue / (360 / HUE_BUCKETS)) % HUE_BUCKETS;
    buckets[bucket].count++;
    buckets[bucket].r += r;
    buckets[bucket].g += g;
    buckets[bucket].b += b;
  }

  let best = -1;
  let bestCount = 0;
  for (let i = 0; i < HUE_BUCKETS; i++) {
    if (buckets[i].count > bestCount) {
      bestCount = buckets[i].count;
      best = i;
    }
  }

  if (best < 0) return { r: 96, g: 96, b: 96 };
  const b = buckets[best];
  return {
    r: Math.round(b.r / b.count),
    g: Math.round(b.g / b.count),
    b: Math.round(b.b / b.count),
  };
}

/** Render text via sharp's Pango-backed text mode. Returns the bitmap and
 * the actual rendered pixel dimensions (so we can size the pill exactly). */
async function renderText(
  text: string,
  fontSize: number,
  colour: string,
): Promise<{ buf: Buffer; width: number; height: number }> {
  const pangoEscaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const r = await sharp({
    text: {
      text: `<span foreground="${colour}">${pangoEscaped}</span>`,
      // Pango font description. With `fontfile`, sharp registers the file with
      // FontConfig and Pango can resolve it by family name.
      font: `${FONT_FAMILY} ${fontSize}`,
      fontfile: FONT_PATH,
      rgba: true,
    },
  }).png().toBuffer({ resolveWithObject: true });
  return { buf: r.data, width: r.info.width, height: r.info.height };
}

interface PillAndText {
  pillSvg: Buffer;
  textBuf: Buffer;
  textX: number;
  textY: number;
}

/**
 * Build the bottom-left "tab" overlay: a pill flush with the left edge
 * (rounded corners only on the right), sized to the *measured* text bitmap
 * so right padding is exactly innerRightPad regardless of which glyphs the
 * playlist name uses. Background is the dominant album colour; text colour
 * is auto-picked for WCAG contrast.
 */
async function buildPillAndText(
  name: string,
  bgRgb: { r: number; g: number; b: number },
): Promise<PillAndText> {
  const innerLeftPad = 96;
  const innerRightPad = 96;
  const innerTopBottomPad = 28;
  const cornerRadius = 28;
  const minFontSize = 64;
  const maxFontSize = 132;
  const bottomMargin = 96;
  const maxPillWidth = FINAL_SIZE - 48;
  const targetTextWidth = maxPillWidth - innerLeftPad - innerRightPad;

  const luminance = relativeLuminance(bgRgb.r, bgRgb.g, bgRgb.b);
  const textColour = luminance > 0.4 ? '#0a0a0a' : '#ffffff';

  // Measure at the largest size first. If the text exceeds the budget, scale
  // the font proportionally and re-measure (a single proportional step almost
  // always lands within budget; the trailing while-loop is a safety net).
  let fontSize = maxFontSize;
  let rendered = await renderText(name, fontSize, textColour);
  if (rendered.width > targetTextWidth) {
    fontSize = Math.max(
      minFontSize,
      Math.floor((fontSize * targetTextWidth) / rendered.width),
    );
    rendered = await renderText(name, fontSize, textColour);
  }
  while (rendered.width > targetTextWidth && fontSize > minFontSize) {
    fontSize -= 4;
    rendered = await renderText(name, fontSize, textColour);
  }

  const pillWidth = innerLeftPad + rendered.width + innerRightPad;
  const pillHeight = rendered.height + innerTopBottomPad * 2;
  const pillY = FINAL_SIZE - bottomMargin - pillHeight;
  const textX = innerLeftPad;
  const textY = pillY + innerTopBottomPad;

  const bgFill = `rgb(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b})`;
  // Trick: render the pill with x = -cornerRadius and width += cornerRadius
  // so the left rounded corners go off-canvas and we get a flush-left tab
  // shape with rounded corners only on the right.
  const pillSvg = Buffer.from(
    `
<svg width="${FINAL_SIZE}" height="${FINAL_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="${-cornerRadius}" y="${pillY}" width="${pillWidth + cornerRadius}" height="${pillHeight}"
        rx="${cornerRadius}" ry="${cornerRadius}"
        fill="${bgFill}" filter="url(#lift)"/>
</svg>`.trim(),
  );

  return { pillSvg, textBuf: rendered.buf, textX, textY };
}

async function composeArt(name: string, imageBuffers: Buffer[]): Promise<Buffer> {
  if (imageBuffers.length === 0) {
    throw new Error(`composeArt called with zero images for "${name}"`);
  }

  // 1. Build the album-art grid with whatever layout fits the count.
  const layout = layoutFor(imageBuffers.length);
  const cells: Cell[] = [];
  for (let i = 0; i < layout.length; i++) {
    const slot = layout[i];
    const resized = await sharp(imageBuffers[i])
      .resize(slot.width, slot.height, { fit: 'cover', position: 'centre' })
      .toBuffer();
    cells.push({ buf: resized, ...slot });
  }

  let baseBuf = await sharp({
    create: {
      width: FINAL_SIZE,
      height: FINAL_SIZE,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(cells.map((c) => ({ input: c.buf, left: c.left, top: c.top })))
    .png()
    .toBuffer();

  // 2. Apply the CD overlay PNG with `screen` blend — only lightens, never
  // darkens, so we get the reflective shimmer without the disc shape blacking
  // out the album art. Black areas in the overlay become invisible.
  const cdOverlay = await getCdOverlay();
  baseBuf = await sharp(baseBuf)
    .composite([{ input: cdOverlay, blend: 'screen' }])
    .png()
    .toBuffer();

  // 3. Pick a vivid colour from the post-blend image (hue-bucketed, ignores
  // muddy averages). The pill matches what the user actually sees.
  const dom = await pickVividColour(baseBuf);

  // 4. Build the pill rect (SVG) and text bitmap (Pango); composite both.
  const { pillSvg, textBuf, textX, textY } = await buildPillAndText(name, dom);
  const overlays = [
    { input: pillSvg, left: 0, top: 0 },
    { input: textBuf, left: textX, top: textY },
  ];

  // 5. Encode JPEG, stepping down quality if we overshoot Spotify's 256KB cap
  // on the base64 payload.
  let quality = 85;
  let composited = await sharp(baseBuf)
    .composite(overlays)
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  while (Buffer.byteLength(composited.toString('base64'), 'utf8') > SPOTIFY_IMAGE_BUDGET && quality > 40) {
    quality -= 10;
    composited = await sharp(baseBuf)
      .composite(overlays)
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }
  return composited;
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

/** Build the Spotify playlist description string. Capped to ~300 chars. */
function buildDescription(entry: TaxonomyEntry, coverArtists: string[]): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const baseDesc = entry.description.replace(/\s+/g, ' ').trim();
  const coverPart = coverArtists.length > 0
    ? ` · Cover: ${coverArtists.join(', ')}`
    : '';
  const updatedPart = ` · Updated ${today}`;
  // Spotify's hard cap is 300 chars; keep some headroom.
  const overhead = coverPart.length + updatedPart.length;
  const maxBase = 290 - overhead;
  const trimmedBase = baseDesc.length > maxBase
    ? baseDesc.slice(0, maxBase - 1).trimEnd() + '…'
    : baseDesc;
  return trimmedBase + coverPart + updatedPart;
}

async function processPlaylist(
  entry: TaxonomyEntry,
  db: Database,
  spotify: SpotifyClient,
  trackById: Map<string, TrackResp>,
): Promise<ProcessResult> {
  const name = entry.name;
  const cachePath = join(ART_DIR, `${slugify(name)}.jpg`);

  const playlistId = getPlaylistMapping(db, name);
  if (!playlistId) {
    return { name, status: 'skipped-no-mapping', message: 'no Spotify playlist id in state DB — run sync first' };
  }

  // Resolve unique albums + their primary artist names. Used both for the
  // cover image AND the description's "Cover: ..." credit.
  const trackIds = recentTracksForPlaylist(db, name);
  const seenAlbums = new Set<string>();
  const uniqueImageUrls: string[] = [];
  const coverArtists: string[] = [];
  for (const id of trackIds) {
    const t = trackById.get(id);
    if (!t?.album?.id || !t.album.images || t.album.images.length === 0) continue;
    if (seenAlbums.has(t.album.id)) continue;
    seenAlbums.add(t.album.id);
    uniqueImageUrls.push(t.album.images[0].url);
    coverArtists.push(t.artists?.[0]?.name ?? 'unknown');
    if (uniqueImageUrls.length === 4) break;
  }

  if (uniqueImageUrls.length === 0) {
    return {
      name,
      status: 'skipped-not-ready',
      message: 'no classified tracks with album art yet',
    };
  }

  // Cache check: if a JPEG already exists and we're not in --force mode, just
  // re-upload it. Re-uploading is idempotent on Spotify's side and cheap.
  let jpeg: Buffer;
  let regenerated: boolean;

  if (!FORCE && existsSync(cachePath)) {
    jpeg = await readFile(cachePath);
    regenerated = false;
  } else {
    const buffers = await Promise.all(uniqueImageUrls.map(downloadImage));
    jpeg = await composeArt(name, buffers);
    await mkdir(ART_DIR, { recursive: true });
    await writeFile(cachePath, jpeg);
    regenerated = true;
  }

  await uploadPlaylistImage(spotify, playlistId, jpeg.toString('base64'));

  // Update the description with the cover credit + last-updated stamp.
  const description = buildDescription(entry, coverArtists);
  await updatePlaylistDetails(spotify, playlistId, { description });

  const artistsLine = ` · cover: ${coverArtists.join(', ')}`;
  return regenerated
    ? { name, status: 'generated', message: `${jpeg.length}B${artistsLine}` }
    : { name, status: 'reuploaded', message: `from cache, ${jpeg.length}B${artistsLine}` };
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
        const r = await processPlaylist(entry, db, spotify, trackById);
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
