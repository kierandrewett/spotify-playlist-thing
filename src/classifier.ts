/**
 * Classifier: takes an EnrichedTrack + TaxonomyConfig and calls OpenRouter via
 * the openai SDK to decide which playlists the track belongs in.
 *
 * Returns a ClassificationResult with playlist names validated against the
 * taxonomy (hallucinated names are silently dropped; the caller decides what
 * to do with an empty result).
 *
 * Errors from the API or malformed JSON are thrown — the caller (sync.ts)
 * should wrap in try/catch and decide whether to skip or abort.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import type { EnrichedTrack, TaxonomyConfig, ClassificationResult, TaxonomyEntry } from './types.js';

// ── Public interface ──────────────────────────────────────────────────────────

export interface ClassifierClient {
  apiKey: string;
  /** OpenRouter model slug, e.g. "google/gemini-2.5-flash". */
  model: string;
}

export function createClassifier(apiKey: string, model: string): ClassifierClient {
  return { apiKey, model };
}

// ── Zod schema for LLM response ───────────────────────────────────────────────

const ResponseSchema = z.object({
  playlists: z.array(z.string()),
});

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildSystemPrompt(maxPlaylistsPerTrack: number): string {
  return `You categorise songs into a fixed list of playlists.

Output strict JSON: {"playlists": ["name1", "name2", ...]}.
- Use ONLY playlist names from the user-provided list. Hallucinated names will be rejected.
- Pick at most ${maxPlaylistsPerTrack} playlists.
- Be conservative — if the song does not strongly fit a playlist, omit it. An empty list is valid and often correct.
- Prefer fewer, stronger matches over many weak ones.`;
}

function formatLastfmTags(tags: EnrichedTrack['lastfmTags']): string {
  if (tags.length === 0) return 'none';
  return tags
    .slice(0, 10)
    .map((t) => `${t.name} (${t.weight})`)
    .join(', ');
}

function formatAudioBlock(audio: EnrichedTrack['audio']): string {
  if (!audio) return '(unavailable)';
  const keyStr = `${audio.key} ${audio.scale}`;
  return [
    `BPM: ${audio.bpm}`,
    `Key: ${keyStr}`,
    `Energy: ${audio.energy.toFixed(2)}`,
    `Danceability: ${audio.danceability.toFixed(2)}`,
    `Mood — happy: ${audio.mood.happy.toFixed(2)}, sad: ${audio.mood.sad.toFixed(2)}, aggressive: ${audio.mood.aggressive.toFixed(2)}, relaxed: ${audio.mood.relaxed.toFixed(2)}`,
  ].join('\n');
}

function formatPlaylistEntry(entry: TaxonomyEntry): string {
  const lines: string[] = [
    `- "${entry.name}" — ${entry.description}`,
    `  Fits: ${entry.fits.join(', ')}`,
  ];

  if (entry.audioHints) {
    const hints = entry.audioHints;
    const hintParts: string[] = [];
    if (hints.tempo) hintParts.push(`tempo ${hints.tempo}`);
    if (hints.energy) hintParts.push(`energy ${hints.energy}`);
    if (hints.danceability) hintParts.push(`danceability ${hints.danceability}`);
    if (hints.mood) hintParts.push(`mood ${hints.mood}`);
    if (hints.vocal) hintParts.push(`vocal ${hints.vocal}`);
    if (hintParts.length > 0) {
      lines.push(`  Audio hints: ${hintParts.join(', ')}`);
    }
  }

  if (entry.avoid && entry.avoid.length > 0) {
    lines.push(`  Avoid: ${entry.avoid.join(', ')}`);
  }

  return lines.join('\n');
}

function buildUserMessage(enriched: EnrichedTrack, taxonomy: TaxonomyConfig): string {
  const { track, artistGenres, lastfmTags, musicbrainz, audio } = enriched;

  const artistsCommaSeparated = track.artists.map((a) => a.name).join(', ');
  const releaseYear = track.album.release_date.slice(0, 4);
  const lastfmTagsCompact = formatLastfmTags(lastfmTags);
  const audioBlock = formatAudioBlock(audio);
  const playlistList = taxonomy.playlists.map(formatPlaylistEntry).join('\n');

  const mbGenres = musicbrainz?.genres.join(', ') || 'none';
  const mbTags = musicbrainz?.tags.join(', ') || 'none';
  const spotifyGenres = artistGenres.join(', ') || 'none';

  return `Track: "${track.name}" by ${artistsCommaSeparated}
Album: "${track.album.name}" (${releaseYear})

Spotify artist genres: ${spotifyGenres}

Last.fm top tags: ${lastfmTagsCompact}
MusicBrainz genres: ${mbGenres}
MusicBrainz tags: ${mbTags}

Audio features: ${audioBlock}

Available playlists (pick from these names ONLY):
${playlistList}`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function classify(
  client: ClassifierClient,
  enriched: EnrichedTrack,
  taxonomy: TaxonomyConfig,
): Promise<ClassificationResult> {
  const openai = new OpenAI({
    apiKey: client.apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/kierandrewett/spotify-playlist-thing',
      'X-Title': 'spotify-playlist-thing',
    },
  });

  const systemPrompt = buildSystemPrompt(taxonomy.maxPlaylistsPerTrack);
  const userMessage = buildUserMessage(enriched, taxonomy);

  const completion = await openai.chat.completions.create({
    model: client.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  const rawContent = completion.choices[0]?.message?.content ?? '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error(
      `Classifier returned malformed JSON for track "${enriched.track.name}".\nRaw response: ${rawContent}`,
    );
  }

  const result = ResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Classifier response failed schema validation for track "${enriched.track.name}".\n` +
        `Zod errors: ${JSON.stringify(result.error.issues)}\n` +
        `Raw response: ${rawContent}`,
    );
  }

  // Build a lowercase lookup set of valid taxonomy names for safety filtering.
  const validNames = new Set(
    taxonomy.playlists.map((p) => p.name.toLowerCase()),
  );

  // Map lowercase back to canonical name for correct casing in output.
  const canonicalByLower = new Map<string, string>(
    taxonomy.playlists.map((p) => [p.name.toLowerCase(), p.name]),
  );

  // Filter out hallucinated names and cap at maxPlaylistsPerTrack.
  const filtered = result.data.playlists
    .filter((name) => validNames.has(name.toLowerCase()))
    .map((name) => canonicalByLower.get(name.toLowerCase()) as string)
    .slice(0, taxonomy.maxPlaylistsPerTrack);

  return { playlists: filtered };
}
