import { createMusicbrainzClient, lookupByIsrc } from '../src/musicbrainz.js';
import { openDb } from '../src/state.js';

const email = process.env.MUSICBRAINZ_CONTACT_EMAIL ?? 'smoke-test@example.com';
const client = createMusicbrainzClient(email);
const db = openDb(':memory:');
// "Karma Police" by Radiohead — known to exist in MB
const result = await lookupByIsrc(client, db, 'GBAYE0601650');
console.log('lookup result:', result);
console.log('cache hit on retry:', await lookupByIsrc(client, db, 'GBAYE0601650'));
