import { createLastfmClient, getTrackTags } from '../src/lastfm.js';
import { openDb } from '../src/state.js';

const apiKey = process.env.LASTFM_API_KEY;
if (!apiKey) {
  console.log('SKIP: LASTFM_API_KEY not set; structural check only');
  console.log('createLastfmClient typeof:', typeof createLastfmClient);
  process.exit(0);
}
const client = createLastfmClient(apiKey);
const db = openDb(':memory:');
const tags = await getTrackTags(client, db, 'test:1', 'Radiohead', 'Karma Police');
console.log('tags:', tags);
