/**
 * Shared type definitions for the spotify-playlist-thing project.
 * All other modules import their types from here.
 */

/** A minimal artist reference as returned by Spotify track objects. */
export interface SpotifyArtistRef {
  id: string;
  name: string;
}

/** A Spotify track as returned from /me/tracks. */
export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: SpotifyArtistRef[];
  album: {
    id: string;
    name: string;
    release_date: string;
  };
  /** International Standard Recording Code — may be absent for some tracks. */
  isrc: string | null;
  /** 30-second preview MP3 URL. Often null for new apps (use iTunes fallback). */
  preview_url: string | null;
  /** ISO 8601 timestamp of when the track was liked. */
  added_at: string;
}

/** A Spotify artist with genre tags. */
export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
}

/** A single Last.fm tag with a normalised weight (0–100). */
export interface LastfmTag {
  name: string;
  /** Normalised weight in the range [0, 100]. */
  weight: number;
}

/** Genre and free-form tags sourced from MusicBrainz (looked up by ISRC). */
export interface MusicbrainzTags {
  genres: string[];
  tags: string[];
}

/** Audio features extracted from the 30-second preview via Essentia.js. */
export interface AudioFeatures {
  /** Beats per minute. Not normalised — raw BPM value. */
  bpm: number;
  /** Musical key, e.g. "C", "F#". */
  key: string;
  scale: 'major' | 'minor';
  /** Normalised energy in [0, 1]. */
  energy: number;
  /** Normalised danceability in [0, 1]. */
  danceability: number;
  mood: {
    /** Probability-like score in [0, 1]. */
    happy: number;
    sad: number;
    aggressive: number;
    relaxed: number;
  };
}

/**
 * A fully enriched track — the input to the classifier.
 * Combines Spotify data with enrichment from Last.fm, MusicBrainz, and Essentia.
 */
export interface EnrichedTrack {
  track: SpotifyTrack;
  /** Flattened list of genres from all Spotify artists on the track. */
  artistGenres: string[];
  lastfmTags: LastfmTag[];
  /** null when the ISRC is missing or the MusicBrainz lookup fails/has no data. */
  musicbrainz: MusicbrainzTags | null;
  /** null when the preview URL is unavailable or Essentia analysis fails. */
  audio: AudioFeatures | null;
}

/**
 * A single playlist entry inside taxonomy.yaml.
 * audio_hints keys are optional — use only the ones relevant to the vibe.
 */
export interface TaxonomyEntry {
  name: string;
  description: string;
  /** Genre/vibe strings that strongly fit this playlist. */
  fits: string[];
  audioHints?: {
    tempo?: string;
    energy?: string;
    danceability?: string;
    mood?: string;
    vocal?: string;
  };
  /** Tags / genres / vibes to exclude this playlist for. */
  avoid?: string[];
}

/** The full parsed and validated taxonomy config (camelCase). */
export interface TaxonomyConfig {
  /** Prefix prepended to every managed playlist name in Spotify, e.g. "🎧 ". */
  playlistPrefix: string;
  /** Maximum number of playlists the classifier may assign to a single track. */
  maxPlaylistsPerTrack: number;
  /**
   * Monotonically increasing integer. Bump to force re-classification of every
   * cached track (e.g. after major taxonomy restructuring).
   */
  taxonomyVersion: number;
  /** OpenRouter model slug used for classification. */
  classifierModel: string;
  playlists: TaxonomyEntry[];
}

/** The raw output of the classifier — a list of playlist names from the taxonomy. */
export interface ClassificationResult {
  /** Names matched against the taxonomy. May be empty. */
  playlists: string[];
}
