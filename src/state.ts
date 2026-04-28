/**
 * SQLite state layer using better-sqlite3.
 *
 * Schema matches the spec in PLAN.md exactly. WAL mode is enabled for
 * safe concurrent reads during long sync runs.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { SpotifyTrack, LastfmTag, MusicbrainzTags, AudioFeatures } from './types.js';

// ── Statement cache ────────────────────────────────────────────────────────────
// We attach cached prepared statements to the Database instance using a symbol
// so we don't pollute the type with arbitrary string keys.

const STMT = Symbol('stmts');

interface CachedStatements {
  allTrackedIds: Statement;
  upsertTrack: Statement;
  markRemoved: Statement;
  deleteClassifications: Statement;
  insertClassification: Statement;
  getClassifications: Statement;
  reclassificationIds: Statement;
  getLastfmCache: Statement;
  setLastfmCache: Statement;
  getMusicbrainzCache: Statement;
  setMusicbrainzCache: Statement;
  getAudioCache: Statement;
  setAudioCache: Statement;
  getPlaylistMapping: Statement;
  setPlaylistMapping: Statement;
}

type DbWithCache = DatabaseType & { [STMT]?: CachedStatements };

// ── Schema ─────────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS tracks (
  spotify_id       TEXT PRIMARY KEY,
  name             TEXT,
  artists          TEXT,
  album            TEXT,
  isrc             TEXT,
  added_at         TEXT,
  classified_at    TEXT,
  taxonomy_version INTEGER,
  removed_at       TEXT
);

CREATE TABLE IF NOT EXISTS classifications (
  spotify_id    TEXT,
  playlist_name TEXT,
  PRIMARY KEY (spotify_id, playlist_name)
);

CREATE TABLE IF NOT EXISTS playlists (
  name                TEXT PRIMARY KEY,
  spotify_playlist_id TEXT
);

CREATE TABLE IF NOT EXISTS lastfm_cache (
  spotify_id TEXT PRIMARY KEY,
  tags_json  TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS musicbrainz_cache (
  isrc       TEXT PRIMARY KEY,
  tags_json  TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS audio_cache (
  spotify_id    TEXT PRIMARY KEY,
  features_json TEXT,
  fetched_at    TEXT
);
`.trim();

// ── Singleton handle ───────────────────────────────────────────────────────────

let _db: DbWithCache | null = null;

/**
 * Open (or reuse) the SQLite database at `path`.
 * Enables WAL mode, applies the schema, and returns the handle.
 */
export function openDb(path = './state.sqlite'): DatabaseType {
  if (_db !== null) return _db;

  const db: DbWithCache = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(DDL);

  _db = db;
  return db;
}

// ── Statement helper ───────────────────────────────────────────────────────────

function stmts(db: DbWithCache): CachedStatements {
  if (db[STMT]) return db[STMT]!;

  db[STMT] = {
    allTrackedIds: db.prepare(
      `SELECT spotify_id FROM tracks WHERE removed_at IS NULL`,
    ),
    upsertTrack: db.prepare(`
      INSERT INTO tracks (spotify_id, name, artists, album, isrc, added_at, classified_at, taxonomy_version, removed_at)
      VALUES (@spotify_id, @name, @artists, @album, @isrc, @added_at, @classified_at, @taxonomy_version, NULL)
      ON CONFLICT(spotify_id) DO UPDATE SET
        name             = excluded.name,
        artists          = excluded.artists,
        album            = excluded.album,
        isrc             = excluded.isrc,
        added_at         = excluded.added_at,
        classified_at    = excluded.classified_at,
        taxonomy_version = excluded.taxonomy_version,
        removed_at       = NULL
    `),
    markRemoved: db.prepare(
      `UPDATE tracks SET removed_at = @removed_at WHERE spotify_id = @spotify_id`,
    ),
    deleteClassifications: db.prepare(
      `DELETE FROM classifications WHERE spotify_id = ?`,
    ),
    insertClassification: db.prepare(
      `INSERT OR IGNORE INTO classifications (spotify_id, playlist_name) VALUES (?, ?)`,
    ),
    getClassifications: db.prepare(
      `SELECT playlist_name FROM classifications WHERE spotify_id = ?`,
    ),
    reclassificationIds: db.prepare(
      `SELECT spotify_id FROM tracks WHERE taxonomy_version < ? AND removed_at IS NULL`,
    ),
    getLastfmCache: db.prepare(
      `SELECT tags_json FROM lastfm_cache WHERE spotify_id = ?`,
    ),
    setLastfmCache: db.prepare(`
      INSERT INTO lastfm_cache (spotify_id, tags_json, fetched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(spotify_id) DO UPDATE SET tags_json = excluded.tags_json, fetched_at = excluded.fetched_at
    `),
    getMusicbrainzCache: db.prepare(
      `SELECT tags_json FROM musicbrainz_cache WHERE isrc = ?`,
    ),
    setMusicbrainzCache: db.prepare(`
      INSERT INTO musicbrainz_cache (isrc, tags_json, fetched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(isrc) DO UPDATE SET tags_json = excluded.tags_json, fetched_at = excluded.fetched_at
    `),
    getAudioCache: db.prepare(
      `SELECT features_json FROM audio_cache WHERE spotify_id = ?`,
    ),
    setAudioCache: db.prepare(`
      INSERT INTO audio_cache (spotify_id, features_json, fetched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(spotify_id) DO UPDATE SET features_json = excluded.features_json, fetched_at = excluded.fetched_at
    `),
    getPlaylistMapping: db.prepare(
      `SELECT spotify_playlist_id FROM playlists WHERE name = ?`,
    ),
    setPlaylistMapping: db.prepare(`
      INSERT INTO playlists (name, spotify_playlist_id)
      VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET spotify_playlist_id = excluded.spotify_playlist_id
    `),
  };

  return db[STMT]!;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Returns a Set of spotify_ids that are currently tracked (not removed). */
export function allTrackedIds(db: DatabaseType): Set<string> {
  const s = stmts(db as DbWithCache);
  const rows = s.allTrackedIds.all() as Array<{ spotify_id: string }>;
  return new Set(rows.map((r) => r.spotify_id));
}

/** Insert or update a track row. Clears `removed_at` on re-like. */
export function upsertTrack(
  db: DatabaseType,
  track: SpotifyTrack,
  classifiedAt: string,
  taxonomyVersion: number,
): void {
  const s = stmts(db as DbWithCache);
  s.upsertTrack.run({
    spotify_id: track.id,
    name: track.name,
    artists: JSON.stringify(track.artists),
    album: JSON.stringify(track.album),
    isrc: track.isrc,
    added_at: track.added_at,
    classified_at: classifiedAt,
    taxonomy_version: taxonomyVersion,
  });
}

/** Soft-delete a track (set removed_at). */
export function markRemoved(
  db: DatabaseType,
  spotifyId: string,
  removedAt: string,
): void {
  const s = stmts(db as DbWithCache);
  s.markRemoved.run({ spotify_id: spotifyId, removed_at: removedAt });
}

/**
 * Replace all classification rows for a track in a single transaction.
 * Pass an empty array to clear all classifications.
 */
export function recordClassifications(
  db: DatabaseType,
  spotifyId: string,
  playlistNames: string[],
): void {
  const s = stmts(db as DbWithCache);
  const run = db.transaction(() => {
    s.deleteClassifications.run(spotifyId);
    for (const name of playlistNames) {
      s.insertClassification.run(spotifyId, name);
    }
  });
  run();
}

/** Return the playlist names a track is classified into. */
export function getClassifications(
  db: DatabaseType,
  spotifyId: string,
): string[] {
  const s = stmts(db as DbWithCache);
  const rows = s.getClassifications.all(spotifyId) as Array<{
    playlist_name: string;
  }>;
  return rows.map((r) => r.playlist_name);
}

/**
 * Return spotify_ids of non-removed tracks whose taxonomy_version is behind
 * the current version (i.e. need re-classification).
 */
export function getTracksForReclassification(
  db: DatabaseType,
  currentTaxonomyVersion: number,
): string[] {
  const s = stmts(db as DbWithCache);
  const rows = s.reclassificationIds.all(currentTaxonomyVersion) as Array<{
    spotify_id: string;
  }>;
  return rows.map((r) => r.spotify_id);
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

export function getLastfmCache(
  db: DatabaseType,
  spotifyId: string,
): LastfmTag[] | null {
  const s = stmts(db as DbWithCache);
  const row = s.getLastfmCache.get(spotifyId) as
    | { tags_json: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.tags_json) as LastfmTag[];
}

export function setLastfmCache(
  db: DatabaseType,
  spotifyId: string,
  tags: LastfmTag[],
): void {
  const s = stmts(db as DbWithCache);
  s.setLastfmCache.run(spotifyId, JSON.stringify(tags), new Date().toISOString());
}

export function getMusicbrainzCache(
  db: DatabaseType,
  isrc: string,
): MusicbrainzTags | null {
  const s = stmts(db as DbWithCache);
  const row = s.getMusicbrainzCache.get(isrc) as
    | { tags_json: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.tags_json) as MusicbrainzTags;
}

export function setMusicbrainzCache(
  db: DatabaseType,
  isrc: string,
  tags: MusicbrainzTags,
): void {
  const s = stmts(db as DbWithCache);
  s.setMusicbrainzCache.run(isrc, JSON.stringify(tags), new Date().toISOString());
}

export function getAudioCache(
  db: DatabaseType,
  spotifyId: string,
): AudioFeatures | null {
  const s = stmts(db as DbWithCache);
  const row = s.getAudioCache.get(spotifyId) as
    | { features_json: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.features_json) as AudioFeatures;
}

export function setAudioCache(
  db: DatabaseType,
  spotifyId: string,
  features: AudioFeatures,
): void {
  const s = stmts(db as DbWithCache);
  s.setAudioCache.run(
    spotifyId,
    JSON.stringify(features),
    new Date().toISOString(),
  );
}

export function getPlaylistMapping(
  db: DatabaseType,
  name: string,
): string | null {
  const s = stmts(db as DbWithCache);
  const row = s.getPlaylistMapping.get(name) as
    | { spotify_playlist_id: string }
    | undefined;
  return row?.spotify_playlist_id ?? null;
}

export function setPlaylistMapping(
  db: DatabaseType,
  name: string,
  spotifyPlaylistId: string,
): void {
  const s = stmts(db as DbWithCache);
  s.setPlaylistMapping.run(name, spotifyPlaylistId);
}
