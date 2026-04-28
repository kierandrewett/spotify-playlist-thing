/**
 * src/sync.ts — orchestrator entrypoint.
 *
 * Usage:
 *   pnpm tsx src/sync.ts [--dry-run] [--debug-track <spotify-id>]
 *
 * --dry-run:            Read + classify + log decisions; skip all Spotify writes;
 *                       do not commit DB. Prints a summary at the end.
 * --debug-track <id>:  Classify a single track end-to-end and print enriched
 *                       data + raw classification result. Skip everything else.
 */

import 'dotenv/config';
import { existsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

import {
  createSpotifyClient,
  getLikedTracks,
  getArtists,
  getOrCreatePlaylist,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  replacePlaylistItems,
  createPrivatePlaylist,
} from './spotify.js';
import { createLastfmClient, getTrackTags } from './lastfm.js';
import { createMusicbrainzClient, lookupByIsrc } from './musicbrainz.js';
import { getItunesPreviewUrl } from './itunes.js';
import { extractAudioFeatures } from './audio.js';
import {
  openDb,
  allTrackedIds,
  upsertTrack,
  markRemoved,
  recordClassifications,
  getClassifications,
  getTracksForReclassification,
  getPlaylistMapping,
  setPlaylistMapping,
} from './state.js';
import { loadTaxonomy } from './taxonomy.js';
import { createClassifier, classify } from './classifier.js';
import { collectArtTrackIds, fetchTracksForArt, generatePlaylistArt } from './art.js';

import type { SpotifyTrack, EnrichedTrack, TaxonomyConfig } from './types.js';
import type { SpotifyClient } from './spotify.js';
import type { LastfmClient } from './lastfm.js';
import type { MusicbrainzClient } from './musicbrainz.js';
import type { ClassifierClient } from './classifier.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const debugTrackIdx = args.indexOf('--debug-track');
const DEBUG_TRACK_ID: string | null =
  debugTrackIdx !== -1 ? (args[debugTrackIdx + 1] ?? null) : null;

// ---------------------------------------------------------------------------
// Env-var validation
// ---------------------------------------------------------------------------

/**
 * All six env vars are required. Spotify credentials are needed even in
 * dry-run mode because we still read liked tracks from the API.
 * The spec phrase "dry-run can use placeholders for write-only secrets"
 * refers to secrets that are ONLY used for Spotify write calls (none exist
 * here — all three Spotify vars are also needed for reads).
 */
const REQUIRED_ENV_VARS = [
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REFRESH_TOKEN',
  'LASTFM_API_KEY',
  'OPENROUTER_API_KEY',
  'MUSICBRAINZ_CONTACT_EMAIL',
] as const;

function validateEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) missing.push(key);
  }

  if (missing.length > 0) {
    for (const key of missing) {
      console.error(`❌ missing env: ${key} — see .env.example`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Bounded concurrency pool (~10 lines)
// ---------------------------------------------------------------------------

/**
 * Run `tasks` with at most `concurrency` running simultaneously.
 * Preserves order: result[i] corresponds to tasks[i].
 */
async function pooled<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Track-row reader (direct SQL read — avoids modifying state.ts)
// ---------------------------------------------------------------------------

interface TrackRow {
  spotify_id: string;
  name: string;
  artists: string; // JSON string
  album: string;   // JSON string
  isrc: string | null;
  added_at: string;
  classified_at: string | null;
  taxonomy_version: number | null;
  removed_at: string | null;
}

/**
 * Read a track row directly from DB. Used for re-classification where we
 * reconstruct a SpotifyTrack from the cached state without an API call.
 * This is a thin SELECT inside sync.ts — we are not modifying state.ts.
 */
function getTrackRow(db: Database, spotifyId: string): TrackRow | null {
  const stmt = db.prepare('SELECT * FROM tracks WHERE spotify_id = ?');
  return (stmt.get(spotifyId) as TrackRow | undefined) ?? null;
}

function trackRowToSpotifyTrack(row: TrackRow): SpotifyTrack {
  const artists = JSON.parse(row.artists) as SpotifyTrack['artists'];
  const album = JSON.parse(row.album) as SpotifyTrack['album'];
  return {
    id: row.spotify_id,
    uri: `spotify:track:${row.spotify_id}`,
    name: row.name,
    artists,
    album,
    isrc: row.isrc,
    preview_url: null, // not stored; will be fetched via iTunes fallback if needed
    added_at: row.added_at,
  };
}

// ---------------------------------------------------------------------------
// Core enrichment pipeline (per track)
// ---------------------------------------------------------------------------

async function enrichTrack(
  track: SpotifyTrack,
  artistGenres: string[],
  db: Database,
  lastfm: LastfmClient,
  mb: MusicbrainzClient,
): Promise<EnrichedTrack> {
  const primaryArtist = track.artists[0]?.name ?? '';

  // Parallel: Last.fm + MusicBrainz + iTunes preview + audio features
  const [lastfmTags, mbTags, resolvedPreviewUrl] = await Promise.all([
    getTrackTags(lastfm, db, track.id, primaryArtist, track.name).catch((err) => {
      console.error(`[sync] lastfm failed for ${track.id}: ${String(err)}`);
      return [];
    }),

    (async () => {
      if (!track.isrc) return null;
      try {
        return await lookupByIsrc(mb, db, track.isrc);
      } catch (err) {
        console.error(`[sync] musicbrainz failed for ${track.id}: ${String(err)}`);
        return null;
      }
    })(),

    (async (): Promise<string | null> => {
      if (track.preview_url) return track.preview_url;
      try {
        return await getItunesPreviewUrl(primaryArtist, track.name);
      } catch (err) {
        console.error(`[sync] itunes failed for ${track.id}: ${String(err)}`);
        return null;
      }
    })(),
  ]);

  // Audio features depend on the resolved preview URL
  const audio = resolvedPreviewUrl
    ? await extractAudioFeatures(db, track.id, resolvedPreviewUrl).catch((err) => {
        console.error(`[sync] audio failed for ${track.id}: ${String(err)}`);
        return null;
      })
    : null;

  return {
    track,
    artistGenres,
    lastfmTags,
    musicbrainz: mbTags,
    audio,
  };
}

// ---------------------------------------------------------------------------
// Debug-track mode
// ---------------------------------------------------------------------------

async function runDebugTrack(
  spotifyId: string,
  taxonomy: TaxonomyConfig,
  db: Database,
  spotify: SpotifyClient,
  lastfm: LastfmClient,
  mb: MusicbrainzClient,
  classifier: ClassifierClient,
): Promise<void> {
  console.error(`[debug] fetching track ${spotifyId} from Spotify…`);

  // Fetch single track directly via API
  const state = spotify._internal;
  const accessToken = state.accessToken;
  const res = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(spotifyId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET /v1/tracks/${spotifyId} → ${res.status}: ${body.slice(0, 300)}`);
  }

  // Parse the raw response with unknown then narrow — this debug path is one-off
  const raw = (await res.json()) as Record<string, unknown>;

  const track: SpotifyTrack = {
    id: raw['id'] as string,
    uri: raw['uri'] as string,
    name: raw['name'] as string,
    artists: (raw['artists'] as Array<Record<string, unknown>>).map((a) => ({
      id: a['id'] as string,
      name: a['name'] as string,
    })),
    album: (() => {
      const al = raw['album'] as Record<string, unknown>;
      return {
        id: al['id'] as string,
        name: al['name'] as string,
        release_date: al['release_date'] as string,
      };
    })(),
    isrc: ((raw['external_ids'] as Record<string, unknown> | undefined)?.['isrc'] as string) ?? null,
    preview_url: (raw['preview_url'] as string | null) ?? null,
    added_at: new Date().toISOString(),
  };

  // Fetch artist genres
  const artistIds = track.artists.map((a) => a.id);
  const artistObjs = await getArtists(spotify, artistIds);
  const artistGenres = [...new Set(artistObjs.flatMap((a) => a.genres))];

  console.error('[debug] enriching track…');
  const enriched = await enrichTrack(track, artistGenres, db, lastfm, mb);

  console.log('\n=== EnrichedTrack ===');
  console.log(JSON.stringify(enriched, null, 2));

  console.error('\n[debug] calling classifier…');
  const result = await classify(classifier, enriched, taxonomy);

  console.log('\n=== ClassificationResult ===');
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── 1. Parse args & validate env ─────────────────────────────────────────
  validateEnv();

  // ── 2. Load taxonomy ──────────────────────────────────────────────────────
  const taxonomyPath = './taxonomy.yaml';
  const taxonomyExamplePath = './taxonomy.yaml.example';

  let taxonomy: TaxonomyConfig;
  if (existsSync(taxonomyPath)) {
    taxonomy = loadTaxonomy(taxonomyPath);
  } else if (DRY_RUN && existsSync(taxonomyExamplePath)) {
    console.error('[sync] WARNING: taxonomy.yaml not found; using taxonomy.yaml.example for dry-run');
    taxonomy = loadTaxonomy(taxonomyExamplePath);
  } else {
    console.error(
      `❌ taxonomy.yaml not found at ${taxonomyPath}. Create it from taxonomy.yaml.example.`,
    );
    process.exit(1);
  }

  // ── 3. Open DB ────────────────────────────────────────────────────────────
  const db = openDb('./state.sqlite');

  // ── 4. Construct clients ──────────────────────────────────────────────────
  const spotify = await createSpotifyClient({
    clientId: process.env['SPOTIFY_CLIENT_ID'] ?? '',
    clientSecret: process.env['SPOTIFY_CLIENT_SECRET'] ?? '',
    refreshToken: process.env['SPOTIFY_REFRESH_TOKEN'] ?? '',
  });

  const lastfm = createLastfmClient(process.env['LASTFM_API_KEY']!);
  const mb = createMusicbrainzClient(process.env['MUSICBRAINZ_CONTACT_EMAIL']!);
  const classifier = createClassifier(
    process.env['OPENROUTER_API_KEY']!,
    taxonomy.classifierModel,
  );

  // ── Debug-track mode ──────────────────────────────────────────────────────
  if (DEBUG_TRACK_ID !== null) {
    await runDebugTrack(DEBUG_TRACK_ID, taxonomy, db, spotify, lastfm, mb, classifier);
    return;
  }

  // ── 5. Fetch current liked tracks ─────────────────────────────────────────
  console.error('[sync] fetching liked tracks from Spotify…');
  const likedTracks = await getLikedTracks(spotify);
  const currentIds = new Set(likedTracks.map((t) => t.id));
  const likedById = new Map(likedTracks.map((t) => [t.id, t]));

  // ── 6. Diff vs state ──────────────────────────────────────────────────────
  const previousIds = allTrackedIds(db);

  const newIds = [...currentIds].filter((id) => !previousIds.has(id));
  const removedIds = [...previousIds].filter((id) => !currentIds.has(id));

  // ── 7. Re-classification candidates ──────────────────────────────────────
  const reclassifyIds = getTracksForReclassification(db, taxonomy.taxonomyVersion);

  console.error(
    `[sync] new=${newIds.length} removed=${removedIds.length} reclassify=${reclassifyIds.length}`,
  );

  // ── 8. Build artist genre map for all tracks to process ───────────────────
  // Collect all distinct artist IDs from new tracks + reclassify tracks.
  // For reclassify tracks we reconstruct from DB, so we need artist IDs from there.
  const reclassifyTracks: SpotifyTrack[] = [];
  for (const id of reclassifyIds) {
    // Skip if also in newIds (will be handled there)
    if (currentIds.has(id)) {
      const fromLiked = likedById.get(id);
      if (fromLiked) {
        reclassifyTracks.push(fromLiked);
        continue;
      }
    }
    const row = getTrackRow(db, id);
    if (row) {
      reclassifyTracks.push(trackRowToSpotifyTrack(row));
    } else {
      console.error(`[sync] reclassify: no DB row for ${id}, skipping`);
    }
  }

  // Merge: tracks to classify = new (from liked) + reclassify (not also new)
  const newTracks = newIds.map((id) => likedById.get(id)!);
  const reclassifySet = new Set(reclassifyIds);
  const newSet = new Set(newIds);
  // Avoid double-processing a track that is both new and needs reclassify
  const reclassifyOnlyTracks = reclassifyTracks.filter((t) => !newSet.has(t.id));

  const tracksToClassify: SpotifyTrack[] = [...newTracks, ...reclassifyOnlyTracks];

  // Batch all artist IDs across all classify-candidate tracks
  const allArtistIds = [
    ...new Set(tracksToClassify.flatMap((t) => t.artists.map((a) => a.id))),
  ];
  const artistObjs = await getArtists(spotify, allArtistIds);
  const artistGenresById = new Map(artistObjs.map((a) => [a.id, a.genres]));

  // Helper: get flat deduplicated genres for a track
  function genresForTrack(track: SpotifyTrack): string[] {
    return [
      ...new Set(
        track.artists.flatMap((a) => artistGenresById.get(a.id) ?? []),
      ),
    ];
  }

  // ── Accumulators for batched Spotify writes ───────────────────────────────
  /** playlistName → list of track URIs to add */
  const toAdd = new Map<string, string[]>();
  /** playlistName → list of track URIs to remove */
  const toRemove = new Map<string, string[]>();

  function queueAdd(playlistName: string, uri: string): void {
    const list = toAdd.get(playlistName) ?? [];
    list.push(uri);
    toAdd.set(playlistName, list);
  }

  function queueRemove(playlistName: string, uri: string): void {
    const list = toRemove.get(playlistName) ?? [];
    list.push(uri);
    toRemove.set(playlistName, list);
  }

  // In-process playlist-id cache (supplementing the DB mapping)
  const playlistIdCache = new Map<string, string>();

  async function resolvePlaylistId(playlistName: string): Promise<string> {
    const cached = playlistIdCache.get(playlistName);
    if (cached) return cached;

    const dbId = getPlaylistMapping(db, playlistName);
    if (dbId) {
      playlistIdCache.set(playlistName, dbId);
      return dbId;
    }

    const fullName = `${taxonomy.playlistPrefix}${playlistName}`;
    const spotifyId = await getOrCreatePlaylist(spotify, fullName);
    playlistIdCache.set(playlistName, spotifyId);
    if (!DRY_RUN) {
      setPlaylistMapping(db, playlistName, spotifyId);
    }
    return spotifyId;
  }

  // Taxonomy name set for safety-filtering classifier output
  const taxonomyNames = new Set(taxonomy.playlists.map((p) => p.name));

  // ── Pre-create every taxonomy playlist on Spotify ────────────────────────
  // Optimistic creation: surfaces all playlists in the user's sidebar
  // immediately and eliminates a race when parallel classify tasks both
  // need the same uncreated playlist.
  //
  // Batched: instead of calling getOrCreatePlaylist per missing playlist
  // (which paginates the whole user library each time), we list once and
  // resolve all unmapped names from a single in-memory map.
  if (!DRY_RUN) {
    const missingMappings = taxonomy.playlists.filter(
      (e) => !getPlaylistMapping(db, e.name),
    );
    if (missingMappings.length === 0) {
      console.error(`[sync] all ${taxonomy.playlists.length} playlists already mapped`);
    } else {
      // Just create. We don't try to look up existing playlists by name
      // first — that requires paginating the user's entire library which
      // is slow and rate-limit-prone. The only downside is occasional
      // duplicates if the DB mapping ever gets lost while the playlist
      // still exists on Spotify; trivial to clean manually.
      console.error(
        `[sync] creating ${missingMappings.length}/${taxonomy.playlists.length} missing playlists…`,
      );
      for (const entry of missingMappings) {
        const fullName = `${taxonomy.playlistPrefix}${entry.name}`;
        const playlistId = await createPrivatePlaylist(spotify, fullName);
        setPlaylistMapping(db, entry.name, playlistId);
        console.error(`[sync] created "${fullName}"`);
      }
    }

    // ── Generate / re-upload art + refresh descriptions ─────────────────
    // Cached JPEGs are re-uploaded as-is (idempotent on Spotify's side);
    // descriptions are regenerated each run with today's date + current
    // cover artists. Fresh art is only computed for playlists missing a
    // cache file. Use `pnpm art --force` to rebuild covers wholesale.
    try {
      const trackIdsForArt = collectArtTrackIds(db, taxonomy.playlists);
      if (trackIdsForArt.length > 0) {
        console.error(`[sync] resolving album images for ${trackIdsForArt.length} cover-source tracks…`);
        const artTrackById = await fetchTracksForArt(spotify, trackIdsForArt);
        let generated = 0;
        let reuploaded = 0;
        let skipped = 0;
        let i = 0;
        for (const entry of taxonomy.playlists) {
          i++;
          try {
            const r = await generatePlaylistArt(entry, spotify, db, artTrackById, { force: false });
            const tag = r.status === 'generated' ? '✓' : r.status === 'reuploaded' ? '↑' : '⊘';
            console.error(`[sync] art ${i}/${taxonomy.playlists.length} ${tag} ${entry.name}${r.message ? ` — ${r.message}` : ''}`);
            if (r.status === 'generated') generated++;
            else if (r.status === 'reuploaded') reuploaded++;
            else skipped++;
          } catch (err) {
            console.error(`[sync] art ${i}/${taxonomy.playlists.length} ✗ ${entry.name} — ${String(err)}`);
            skipped++;
          }
        }
        console.error(`[sync] art: generated=${generated} reuploaded=${reuploaded} skipped=${skipped}`);
      }
    } catch (err) {
      // Art is best-effort — never block the classify path on it.
      console.error(`[sync] art step failed (continuing): ${String(err)}`);
    }
  }

  // ── Summary counters ──────────────────────────────────────────────────────
  let tracksAdded = 0;
  let tracksReclassified = 0;
  let tracksRemoved = 0;
  let classifierCalls = 0;
  let playlistsAffected = 0;
  /** Set of taxonomy playlist names that received at least one add or remove this run. */
  const playlistNamesTouched = new Set<string>();

  // ── 9. Process tracks to classify (bounded parallelism, 4 at a time) ──────
  const classifyTasks = tracksToClassify.map((track) => async (): Promise<void> => {
    const isReclassify = reclassifySet.has(track.id) && !newSet.has(track.id);
    const action = isReclassify ? 'reclassified' : 'added';

    try {
      const genres = genresForTrack(track);
      const enriched = await enrichTrack(track, genres, db, lastfm, mb);

      // Call classifier
      const result = await classify(classifier, enriched, taxonomy);
      classifierCalls++;

      // Safety: filter to known taxonomy names + cap at maxPlaylistsPerTrack
      const filteredPlaylists = result.playlists
        .filter((name) => taxonomyNames.has(name))
        .slice(0, taxonomy.maxPlaylistsPerTrack);

      // Capture old assignments BEFORE we overwrite them in the DB
      const oldPlaylists = isReclassify ? getClassifications(db, track.id) : [];
      const newSetForTrack = new Set(filteredPlaylists);

      if (DRY_RUN) {
        for (const oldName of oldPlaylists) {
          if (!newSetForTrack.has(oldName)) queueRemove(oldName, track.uri);
        }
        for (const playlistName of filteredPlaylists) {
          queueAdd(playlistName, track.uri);
        }
      } else {
        // Persist to DB FIRST so any later Spotify error still leaves the local
        // state truthful about what we *intend* to have on Spotify. (Spotify
        // adds are idempotent — re-running is safe.)
        upsertTrack(db, track, new Date().toISOString(), taxonomy.taxonomyVersion);
        recordClassifications(db, track.id, filteredPlaylists);

        // Remove from old playlists that aren't in the new set
        for (const oldName of oldPlaylists) {
          if (newSetForTrack.has(oldName)) continue;
          const playlistId = await resolvePlaylistId(oldName);
          await removeTracksFromPlaylist(spotify, playlistId, [track.uri]);
          playlistNamesTouched.add(oldName);
        }
        // Apply new assignments immediately (one small POST per playlist)
        for (const playlistName of filteredPlaylists) {
          if (oldPlaylists.includes(playlistName)) continue; // already there
          const playlistId = await resolvePlaylistId(playlistName);
          await addTracksToPlaylist(spotify, playlistId, [track.uri]);
          playlistNamesTouched.add(playlistName);
        }
      }

      if (isReclassify) {
        tracksReclassified++;
      } else {
        tracksAdded++;
      }

      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          spotifyId: track.id,
          name: track.name,
          artists: track.artists.map((a) => a.name),
          classifications: filteredPlaylists,
          action,
        }),
      );
    } catch (err) {
      console.error(`[sync] track ${track.id} failed: ${String(err)}`);
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          spotifyId: track.id,
          name: track.name,
          artists: track.artists.map((a) => a.name),
          classifications: [],
          action: 'skipped',
        }),
      );
    }
  });

  await pooled(classifyTasks, 4);

  // ── 10. Process removed tracks ────────────────────────────────────────────
  for (const id of removedIds) {
    try {
      const playlists = getClassifications(db, id);
      const uri = `spotify:track:${id}`;

      if (DRY_RUN) {
        for (const playlistName of playlists) queueRemove(playlistName, uri);
      } else {
        // Mark removed in DB first; if a Spotify call fails halfway through
        // the playlists, a re-run will skip this track (already removed) and
        // the leftover Spotify-side rows just sit until the user notices.
        // Acceptable trade for durability.
        markRemoved(db, id, new Date().toISOString());
        for (const playlistName of playlists) {
          const playlistId = await resolvePlaylistId(playlistName);
          await removeTracksFromPlaylist(spotify, playlistId, [uri]);
          playlistNamesTouched.add(playlistName);
        }
      }

      tracksRemoved++;

      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          spotifyId: id,
          name: null,
          artists: [],
          classifications: playlists,
          action: 'removed',
        }),
      );
    } catch (err) {
      console.error(`[sync] track ${id} (remove) failed: ${String(err)}`);
    }
  }

  // ── 11. Tally affected playlists ──────────────────────────────────────────
  if (DRY_RUN) {
    playlistsAffected = new Set([...toAdd.keys(), ...toRemove.keys()]).size;
    console.error('\n[dry-run] would add:');
    for (const [name, uris] of toAdd.entries()) {
      console.error(`  ${name}: ${uris.length} track(s)`);
    }
    console.error('[dry-run] would remove:');
    for (const [name, uris] of toRemove.entries()) {
      console.error(`  ${name}: ${uris.length} track(s)`);
    }
  } else {
    playlistsAffected = playlistNamesTouched.size;
  }

  // ── 11b. Stabilise touched playlists: dedupe + reorder ────────────────────
  // The per-track adds above land tracks on Spotify quickly but can produce
  // duplicates (e.g. a re-classified track added on top of an existing one)
  // and don't enforce ordering. Now we replace each touched playlist with
  // the canonical list from the DB — sorted by added_at DESC to match the
  // Spotify Liked Songs default ordering, and naturally deduped by the
  // (spotify_id, playlist_name) primary key in classifications.
  if (!DRY_RUN && playlistNamesTouched.size > 0) {
    console.error(`[sync] stabilising ${playlistNamesTouched.size} playlists (dedupe + reorder)…`);
    const orderedStmt = db.prepare<[string], { spotify_id: string }>(`
      SELECT t.spotify_id
      FROM classifications c
      JOIN tracks t ON c.spotify_id = t.spotify_id
      WHERE c.playlist_name = ? AND t.removed_at IS NULL
      ORDER BY datetime(t.added_at) DESC
    `);
    for (const playlistName of playlistNamesTouched) {
      try {
        const ids = orderedStmt.all(playlistName).map((r) => r.spotify_id);
        const uris = ids.map((id) => `spotify:track:${id}`);
        const playlistId = await resolvePlaylistId(playlistName);
        await replacePlaylistItems(spotify, playlistId, uris);
      } catch (err) {
        console.error(`[sync] stabilise failed for "${playlistName}": ${String(err)}`);
      }
    }
  }

  // ── 12. Summary ───────────────────────────────────────────────────────────
  console.log(
    JSON.stringify({
      summary: true,
      dryRun: DRY_RUN,
      tracksAdded,
      tracksReclassified,
      tracksRemoved,
      playlistsAffected,
      classifierCalls,
    }),
  );
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
