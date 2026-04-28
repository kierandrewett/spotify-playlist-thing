import { createSpotifyClient } from '../src/spotify.js';

const id = process.env.SPOTIFY_CLIENT_ID;
const secret = process.env.SPOTIFY_CLIENT_SECRET;
const refresh = process.env.SPOTIFY_REFRESH_TOKEN;
if (!id || !secret || !refresh) {
  console.log('SKIP: spotify creds not set; structural check only');
  console.log('createSpotifyClient typeof:', typeof createSpotifyClient);
  process.exit(0);
}
// If creds present, do a real round-trip:
const client = await createSpotifyClient({ clientId: id, clientSecret: secret, refreshToken: refresh });
const { getCurrentUserId } = await import('../src/spotify.js');
console.log('current user id:', await getCurrentUserId(client));
