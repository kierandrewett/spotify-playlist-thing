import { createClassifier, classify } from '../src/classifier.js';
import { loadTaxonomy } from '../src/taxonomy.js';

const apiKey = process.env.OPENROUTER_API_KEY;
const taxonomy = loadTaxonomy('./taxonomy.yaml.example');

if (!apiKey) {
  console.log('SKIP: OPENROUTER_API_KEY not set; structural check only');
  console.log('createClassifier typeof:', typeof createClassifier);
  process.exit(0);
}

const client = createClassifier(apiKey, taxonomy.classifierModel);

const enriched = {
  track: {
    id: 'test',
    uri: 'spotify:track:test',
    name: 'Karma Police',
    artists: [{ id: 'a', name: 'Radiohead' }],
    album: { id: 'b', name: 'OK Computer', release_date: '1997-06-16' },
    isrc: 'GBAYE0601650',
    preview_url: null,
    added_at: new Date().toISOString(),
  },
  artistGenres: ['alternative rock', 'art rock', 'permanent wave'],
  lastfmTags: [
    { name: 'alternative rock', weight: 100 },
    { name: 'rock', weight: 90 },
    { name: 'melancholy', weight: 60 },
  ],
  musicbrainz: { genres: ['alternative rock'], tags: ['rock', 'classic rock'] },
  audio: {
    bpm: 76, key: 'A', scale: 'minor' as const,
    energy: 0.45, danceability: 0.32,
    mood: { happy: 0.2, sad: 0.7, aggressive: 0.15, relaxed: 0.5 },
  },
};

const result = await classify(client, enriched, taxonomy);
console.log('classified into:', result.playlists);
