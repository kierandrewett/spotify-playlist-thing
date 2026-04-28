import { getItunesPreviewUrl } from '../src/itunes.js';

// Should find a preview URL for a famous track.
const url = await getItunesPreviewUrl('Radiohead', 'Karma Police');
console.log('preview url:', url);
if (!url) throw new Error('expected a preview URL for Radiohead — Karma Police');
console.log('OK');
