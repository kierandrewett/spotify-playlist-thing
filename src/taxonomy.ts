/**
 * Taxonomy loader: reads taxonomy.yaml, validates with zod, returns TaxonomyConfig.
 *
 * YAML uses snake_case; zod transforms to camelCase to match TaxonomyConfig.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { TaxonomyConfig } from './types.js';

// ── Zod schema (snake_case input → camelCase output) ──────────────────────────

const AudioHintsSchema = z.object({
  tempo: z.string().optional(),
  energy: z.string().optional(),
  danceability: z.string().optional(),
  mood: z.string().optional(),
  vocal: z.string().optional(),
});

const TaxonomyEntrySchema = z.object({
  name: z.string().min(1, 'Playlist name must not be empty'),
  description: z.string().min(1, 'Playlist description must not be empty'),
  fits: z.array(z.string()).min(1, 'Each playlist must have at least one fit tag'),
  audio_hints: AudioHintsSchema.optional(),
  avoid: z.array(z.string()).optional(),
}).transform((entry) => ({
  name: entry.name,
  description: entry.description,
  fits: entry.fits,
  audioHints: entry.audio_hints,
  avoid: entry.avoid,
}));

export const TaxonomyConfigSchema = z.object({
  playlist_prefix: z.string(),
  max_playlists_per_track: z.number().int().positive(),
  taxonomy_version: z.number().int().positive(),
  classifier_model: z.string().min(1, 'classifier_model must not be empty'),
  playlists: z.array(TaxonomyEntrySchema).min(1, 'At least one playlist is required'),
}).transform((cfg) => ({
  playlistPrefix: cfg.playlist_prefix,
  maxPlaylistsPerTrack: cfg.max_playlists_per_track,
  taxonomyVersion: cfg.taxonomy_version,
  classifierModel: cfg.classifier_model,
  playlists: cfg.playlists,
}));

// Re-export the inferred output type for consumers that want strict typing.
export type TaxonomyConfigInput = z.input<typeof TaxonomyConfigSchema>;

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Load and validate the taxonomy config from a YAML file.
 *
 * @param path - Path to the taxonomy YAML file (default: `./taxonomy.yaml`).
 * @throws If the file cannot be read or the contents fail schema validation.
 */
export function loadTaxonomy(path = './taxonomy.yaml'): TaxonomyConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read taxonomy file at "${path}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse taxonomy YAML at "${path}": ${message}`);
  }

  const result = TaxonomyConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Taxonomy validation failed for "${path}":\n${issues}`,
    );
  }

  return result.data;
}
