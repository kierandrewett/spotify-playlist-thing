/**
 * Playlist cover-art generation + upload.
 *
 * Builds an album-art mosaic with a CD-shimmer overlay and a flush-left
 * coloured pill carrying the playlist name in Inter SemiBold. Uploads the
 * resulting JPEG to Spotify and updates the playlist description with a
 * cover credit + last-updated stamp.
 *
 * Used by:
 *   - `src/sync.ts` (called per playlist after pre-create)
 *   - `scripts/generate-art.ts` (manual CLI entrypoint)
 */

import { existsSync } from 'node:fs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import sharp from 'sharp';

import {
  uploadPlaylistImage,
  updatePlaylistDetails,
  type SpotifyClient,
} from './spotify.js';
import { getPlaylistMapping } from './state.js';
import type { TaxonomyEntry } from './types.js';

// ── Config ────────────────────────────────────────────────────────────────────

export const ART_DIR = './art';
const CD_OVERLAY_PATH = './assets/cd_overlay.png';
const FONT_PATH = './assets/fonts/Inter-SemiBold.ttf';
const FONT_FAMILY = 'Inter SemiBold';
const FINAL_SIZE = 1024;
const HALF = FINAL_SIZE / 2;
const SPOTIFY_IMAGE_BUDGET = 256_000;
const MAX_RECENT_TRACKS = 12;

// ── Track-info shape (a subset of Spotify's track response) ───────────────────

export interface ArtTrackInfo {
  id: string;
  artists?: Array<{ name: string }>;
  album?: {
    id: string;
    images?: Array<{ url: string; width: number; height: number }>;
  };
}

/** Fetches Spotify track metadata in batches of 50 — used by both callers
 *  to resolve album-art URLs and primary-artist names. */
export async function fetchTracksForArt(
  client: SpotifyClient,
  trackIds: string[],
): Promise<Map<string, ArtTrackInfo>> {
  if (trackIds.length === 0) return new Map();
  // Reach into the client's internal access token for raw fetches.
  const state = (client as unknown as { _internal: { accessToken: string } })._internal;
  const out: ArtTrackInfo[] = [];
  for (let i = 0; i < trackIds.length; i += 50) {
    const batch = trackIds.slice(i, i + 50);
    const url = `https://api.spotify.com/v1/tracks?ids=${batch.join(',')}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`fetchTracksForArt HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { tracks: Array<ArtTrackInfo | null> };
    for (const t of data.tracks) if (t) out.push(t);
  }
  return new Map(out.map((t) => [t.id, t]));
}

// ── DB query: most-recent classified tracks per playlist ──────────────────────

export function recentTracksForPlaylist(db: Database, playlistName: string): string[] {
  const stmt = db.prepare<[string], { spotify_id: string }>(`
    SELECT c.spotify_id
    FROM classifications c
    JOIN tracks t ON c.spotify_id = t.spotify_id
    WHERE c.playlist_name = ? AND t.removed_at IS NULL
    ORDER BY t.added_at DESC
    LIMIT ${MAX_RECENT_TRACKS}
  `);
  return stmt.all(playlistName).map((r) => r.spotify_id);
}

/** Collect every distinct track ID we'll need to art-source across the whole
 *  taxonomy. Used by both callers to do a single batched Spotify fetch. */
export function collectArtTrackIds(
  db: Database,
  entries: ReadonlyArray<TaxonomyEntry>,
): string[] {
  const all = new Set<string>();
  for (const entry of entries) {
    for (const id of recentTracksForPlaylist(db, entry.name)) all.add(id);
  }
  return [...all];
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

/** Layout for N unique album images: 1 → full, 2 → stacked halves,
 *  3 → top band + two squares, 4+ → 2×2. */
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

let _cdOverlayBuf: Buffer | null = null;
async function getCdOverlay(): Promise<Buffer> {
  if (_cdOverlayBuf) return _cdOverlayBuf;
  _cdOverlayBuf = await sharp(CD_OVERLAY_PATH)
    .resize(FINAL_SIZE, FINAL_SIZE, { fit: 'cover', position: 'centre' })
    .toBuffer();
  return _cdOverlayBuf;
}

/** WCAG relative luminance — used to pick black vs white text. */
function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Pick a vivid colour from an image — hue-bucketed centroid, ignores muddy
 *  averages that defeat sharp's built-in `dominant`. */
async function pickVividColour(buf: Buffer): Promise<{ r: number; g: number; b: number }> {
  const SAMPLE = 96;
  const HUE_BUCKETS = 12;

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
    const lightness = (max + min) / 510;
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

/** Render text via sharp's Pango text mode. Returns the bitmap and its
 *  measured pixel dimensions. */
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

  const lift = 0.25;
  const lightR = Math.round(bgRgb.r + (255 - bgRgb.r) * lift);
  const lightG = Math.round(bgRgb.g + (255 - bgRgb.g) * lift);
  const lightB = Math.round(bgRgb.b + (255 - bgRgb.b) * lift);
  const luminance = relativeLuminance(lightR, lightG, lightB);
  const textColour = luminance > 0.4 ? '#0a0a0a' : '#ffffff';

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

  // Reference render so every pill is the same height, then offset the actual
  // bitmap so its baseline matches — descenders ("g","y") hang naturally.
  const reference = await renderText('Hg', fontSize, textColour);
  const refHeight = reference.height;
  const DESCENDER_RATIO = 0.20;

  const hasDescender = /[gjpqy]/i.test(name);
  const textBaselineFromTop = hasDescender
    ? Math.round(rendered.height * (1 - DESCENDER_RATIO))
    : rendered.height;
  const refBaselineFromTop = Math.round(refHeight * (1 - DESCENDER_RATIO));

  const pillWidth = innerLeftPad + rendered.width + innerRightPad;
  const pillHeight = refHeight + innerTopBottomPad * 2;
  const pillY = FINAL_SIZE - bottomMargin - pillHeight;
  const textX = innerLeftPad;
  const textY = pillY + innerTopBottomPad + refBaselineFromTop - textBaselineFromTop;

  const bgFill = `rgb(${lightR}, ${lightG}, ${lightB})`;
  const pillSvg = Buffer.from(
    `
<svg width="${FINAL_SIZE}" height="${FINAL_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="black" stop-opacity="0"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.55"/>
    </linearGradient>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="0" y="${FINAL_SIZE * 0.5}" width="${FINAL_SIZE}" height="${FINAL_SIZE * 0.5}"
        fill="url(#bgFade)"/>
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

  const cdOverlay = await getCdOverlay();
  baseBuf = await sharp(baseBuf)
    .composite([{ input: cdOverlay, blend: 'color-dodge' }])
    .png()
    .toBuffer();

  const dom = await pickVividColour(baseBuf);
  const { pillSvg, textBuf, textX, textY } = await buildPillAndText(name, dom);
  const overlays = [
    { input: pillSvg, left: 0, top: 0 },
    { input: textBuf, left: textX, top: textY },
  ];

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

// ── Description ───────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildDescription(entry: TaxonomyEntry, coverArtists: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const baseDesc = entry.description.replace(/\s+/g, ' ').trim();
  const coverPart = coverArtists.length > 0
    ? ` · Cover: ${coverArtists.join(', ')}`
    : '';
  const updatedPart = ` · Updated ${today}`;
  const overhead = coverPart.length + updatedPart.length;
  const maxBase = 290 - overhead;
  const trimmedBase = baseDesc.length > maxBase
    ? baseDesc.slice(0, maxBase - 1).trimEnd() + '…'
    : baseDesc;
  return trimmedBase + coverPart + updatedPart;
}

// ── Public: per-playlist orchestrator ─────────────────────────────────────────

export type ArtStatus =
  | 'generated'
  | 'reuploaded'
  | 'skipped-no-mapping'
  | 'skipped-no-tracks';

export interface ArtResult {
  name: string;
  status: ArtStatus;
  message?: string;
  coverArtists?: string[];
}

export interface GenerateArtOptions {
  /** When true, regenerate the cached JPEG even if it exists. */
  force?: boolean;
}

/**
 * Generate (or reuse cached) cover art for one playlist, upload to Spotify,
 * and update the description. Idempotent — safe to run on every sync.
 *
 * The cache lives at `art/<slug>.jpg`. With force=false, the cached JPEG is
 * re-uploaded and the description is updated; the image bytes aren't
 * recomputed. With force=true, the JPEG is regenerated from current
 * classifications.
 */
export async function generatePlaylistArt(
  entry: TaxonomyEntry,
  spotify: SpotifyClient,
  db: Database,
  trackById: Map<string, ArtTrackInfo>,
  options: GenerateArtOptions = {},
): Promise<ArtResult> {
  const name = entry.name;
  const force = options.force === true;
  const cachePath = join(ART_DIR, `${slugify(name)}.jpg`);

  const playlistId = getPlaylistMapping(db, name);
  if (!playlistId) {
    return { name, status: 'skipped-no-mapping', message: 'no Spotify playlist id in state DB' };
  }

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
    return { name, status: 'skipped-no-tracks', message: 'no classified tracks with album art yet' };
  }

  // While the cover is still growing toward the 4-album cap, regenerate on
  // every sync so the layout updates as new albums get added (1-up → 2-up →
  // 3-up → 2×2). Once we hit 4 distinct albums the layout is stable, so we
  // fall back to the cache and only regenerate on --force.
  const stillGrowing = uniqueImageUrls.length < 4;
  const shouldRegenerate = force || stillGrowing || !existsSync(cachePath);

  let jpeg: Buffer;
  let regenerated: boolean;

  if (!shouldRegenerate) {
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

  const description = buildDescription(entry, coverArtists);
  await updatePlaylistDetails(spotify, playlistId, { description });

  return {
    name,
    status: regenerated ? 'generated' : 'reuploaded',
    message: regenerated ? `${jpeg.length}B` : `from cache, ${jpeg.length}B`,
    coverArtists,
  };
}
