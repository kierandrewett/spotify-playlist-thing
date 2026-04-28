/**
 * Generate playlist cover art (CLI).
 *
 * Thin wrapper around src/art.ts — does arg parsing, batches the Spotify
 * track fetch, runs generatePlaylistArt with bounded concurrency.
 *
 * Usage:
 *   pnpm art                        # generate everything not already cached
 *   pnpm art --force                # regenerate even cached
 *   pnpm art --only "Deep Focus"    # one playlist
 */

import 'dotenv/config';

import { openDb } from '../src/state.js';
import { loadTaxonomy } from '../src/taxonomy.js';
import { createSpotifyClient } from '../src/spotify.js';
import {
  collectArtTrackIds,
  fetchTracksForArt,
  generatePlaylistArt,
  type ArtResult,
} from '../src/art.js';

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY_IDX = args.indexOf('--only');
const ONLY: string | null = ONLY_IDX >= 0 ? args[ONLY_IDX + 1] ?? null : null;
const POOL = 3;

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

  const allTrackIds = collectArtTrackIds(db, targets);
  console.error(`[art] resolving album images for ${allTrackIds.length} tracks…`);
  const trackById = await fetchTracksForArt(spotify, allTrackIds);

  const queue = [...targets];
  const results: ArtResult[] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        const r = await generatePlaylistArt(entry, spotify, db, trackById, { force: FORCE });
        results.push(r);
        const tag = r.status === 'generated' ? '✓'
          : r.status === 'reuploaded' ? '↑'
          : '⏳';
        const cover = r.coverArtists ? ` · cover: ${r.coverArtists.join(', ')}` : '';
        console.error(`[art] ${tag} ${entry.name}${r.message ? ` — ${r.message}` : ''}${cover}`);
      } catch (err) {
        console.error(`[art] ✗ ${entry.name} — ${String(err)}`);
        results.push({ name: entry.name, status: 'skipped-no-tracks', message: String(err) });
      }
    }
  }

  await Promise.all(Array.from({ length: POOL }, worker));

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
