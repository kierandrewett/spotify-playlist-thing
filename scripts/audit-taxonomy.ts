/**
 * Read the local state.sqlite and report:
 *   - tracks with no classifications (taxonomy gaps)
 *   - underused playlists (tight criteria)
 *
 * Usage:
 *   pnpm audit                            # default thresholds
 *   pnpm audit --uncategorised-limit 200  # show more uncategorised tracks
 *   pnpm audit --underused-threshold 10   # treat <10 as underused
 */

import { openDb } from '../src/state.js';
import { loadTaxonomy } from '../src/taxonomy.js';

// ── Args ──────────────────────────────────────────────────────────────────────

function intArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const UNCATEGORISED_LIMIT = intArg('--uncategorised-limit', 80);
const UNDERUSED_THRESHOLD = intArg('--underused-threshold', 5);

// ── Run ───────────────────────────────────────────────────────────────────────

const taxonomy = loadTaxonomy('./taxonomy.yaml');
const db = openDb('./state.sqlite');

interface TrackRow {
  spotify_id: string;
  name: string;
  artists: string;
  album: string;
  added_at: string;
}

const totalTracks = db.prepare<[], { c: number }>(
  `SELECT COUNT(*) AS c FROM tracks WHERE removed_at IS NULL`,
).get()?.c ?? 0;

const uncategorisedRows = db.prepare<[], TrackRow>(`
  SELECT t.spotify_id, t.name, t.artists, t.album, t.added_at
  FROM tracks t
  LEFT JOIN classifications c ON c.spotify_id = t.spotify_id
  WHERE t.removed_at IS NULL AND c.spotify_id IS NULL
  ORDER BY t.added_at DESC
`).all();

const playlistCounts = db.prepare<[], { playlist_name: string; n: number }>(`
  SELECT playlist_name, COUNT(*) AS n
  FROM classifications
  GROUP BY playlist_name
`).all();

const countByName = new Map(playlistCounts.map((r) => [r.playlist_name, r.n]));

// ── Format ────────────────────────────────────────────────────────────────────

function formatArtists(json: string): string {
  try {
    const arr = JSON.parse(json) as Array<{ name: string }>;
    return arr.map((a) => a.name).join(', ');
  } catch {
    return json;
  }
}

console.log('━'.repeat(70));
console.log(` Tracked songs:   ${totalTracks}`);
console.log(` Uncategorised:   ${uncategorisedRows.length} (${((uncategorisedRows.length / Math.max(totalTracks, 1)) * 100).toFixed(1)}%)`);
console.log(` Playlists:       ${taxonomy.playlists.length}`);
console.log('━'.repeat(70));

// Per-playlist counts, ascending — empty/underused at the top so they're easy to spot.
console.log('\n## Playlist usage (ascending)\n');
const allCounts = taxonomy.playlists.map((p) => ({
  name: p.name,
  count: countByName.get(p.name) ?? 0,
}));
allCounts.sort((a, b) => a.count - b.count);

const longestName = Math.max(...allCounts.map((p) => p.name.length));
for (const { name, count } of allCounts) {
  const flag = count === 0 ? '  ✗ EMPTY' : count < UNDERUSED_THRESHOLD ? `  ⚠ <${UNDERUSED_THRESHOLD}` : '';
  console.log(`  ${name.padEnd(longestName)}  ${String(count).padStart(5)}${flag}`);
}

// Uncategorised tracks — print the most-recently-added first so patterns are
// visible at a glance.
console.log(`\n## Uncategorised tracks (${uncategorisedRows.length} total, showing first ${Math.min(uncategorisedRows.length, UNCATEGORISED_LIMIT)})\n`);
for (const t of uncategorisedRows.slice(0, UNCATEGORISED_LIMIT)) {
  console.log(`  ${formatArtists(t.artists)} — ${t.name}`);
}

// ── Suggestions ───────────────────────────────────────────────────────────────

const empty = allCounts.filter((p) => p.count === 0).map((p) => p.name);
const underused = allCounts
  .filter((p) => p.count > 0 && p.count < UNDERUSED_THRESHOLD)
  .map((p) => p.name);

if (empty.length > 0 || underused.length > 0 || uncategorisedRows.length > 0) {
  console.log('\n## Tightening / expansion candidates\n');
  if (empty.length > 0) {
    console.log(`  Empty playlists (consider broadening or removing):`);
    console.log(`    ${empty.join(', ')}`);
  }
  if (underused.length > 0) {
    console.log(`  Underused (<${UNDERUSED_THRESHOLD} tracks — consider broadening):`);
    console.log(`    ${underused.join(', ')}`);
  }
  if (uncategorisedRows.length > 0) {
    console.log(`  ${uncategorisedRows.length} tracks fit nothing → look at the list above for clusters that suggest a new playlist.`);
  }
  console.log('');
}
