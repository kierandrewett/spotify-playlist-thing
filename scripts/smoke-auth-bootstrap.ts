import { runBootstrap } from '../src/auth-bootstrap.js';
console.log('runBootstrap typeof:', typeof runBootstrap);
if (typeof runBootstrap !== 'function') throw new Error('runBootstrap not exported');
console.log('OK');
