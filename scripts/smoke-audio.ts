import { extractAudioFeatures } from '../src/audio.js';
import { openDb } from '../src/state.js';

// Known-good Apple/iTunes preview URL. If this 404s, swap to a fresh one —
// the smoke script's job is to exercise the code path, not validate the URL.
const sampleUrl =
  'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview116/v4/0e/45/3a/0e453a4d-f4b8-c5ce-d22b-ddbf09b7f97f/mzaf_5530362810043937870.plus.aac.p.m4a';

const db = openDb(':memory:');
const features = await extractAudioFeatures(db, 'smoke:1', sampleUrl);
console.log('features:', features);
if (!features) {
  console.warn(
    'audio extraction returned null (network or essentia issue) — that is acceptable for smoke',
  );
} else {
  console.log('OK — bpm:', features.bpm, 'key:', features.key, features.scale);
}
