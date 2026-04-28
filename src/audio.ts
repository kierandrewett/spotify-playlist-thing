/**
 * Audio feature extraction via Essentia.js (WASM) + ffmpeg.
 *
 * Import path settled on after probing the package at runtime:
 *   - EssentiaWASM: require('essentia.js').EssentiaWASM  (UMD bundle, already loaded)
 *   - Essentia:     require('essentia.js').Essentia       (UMD core, already loaded)
 *
 * Because this project is "type": "module" we use a dynamic createRequire to load the
 * CJS index.js entry that ships with essentia.js 0.1.3. The package has no ESM
 * exports field so the CJS shim is the only reliable Node path.
 */

import { createRequire } from 'module';
import { spawn } from 'child_process';
import type { Database } from 'better-sqlite3';
import type { AudioFeatures } from './types.js';
import { getAudioCache, setAudioCache } from './state.js';

// ── Essentia lazy singleton ────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _essentia: any = null;

/** Lazily create the Essentia instance (once per process). */
function getEssentia(): unknown {
  if (_essentia !== null) return _essentia;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg = _require('essentia.js') as { EssentiaWASM: any; Essentia: any };
  _essentia = new pkg.Essentia(pkg.EssentiaWASM);
  return _essentia;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Pipe `inputBuffer` to ffmpeg's stdin and collect stdout as raw f32le PCM.
 * Returns a Float32Array on success or null on non-zero exit.
 */
function decodeWithFfmpeg(inputBuffer: ArrayBuffer): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 'f32le',
      '-ar', '22050',
      '-ac', '1',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    proc.stderr.on('data', () => {
      // Suppress ffmpeg's verbose stderr output intentionally.
    });

    proc.on('error', (err) => {
      console.error('[audio] ffmpeg spawn error:', err.message);
      resolve(null);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[audio] ffmpeg exited with code ${String(code)}`);
        resolve(null);
        return;
      }
      const combined = Buffer.concat(chunks);
      // Interpret raw bytes as 32-bit little-endian floats.
      const float32 = new Float32Array(
        combined.buffer,
        combined.byteOffset,
        combined.byteLength / 4,
      );
      resolve(float32);
    });

    // Write the downloaded audio bytes to ffmpeg's stdin then close it.
    const stdin = proc.stdin;
    stdin.write(Buffer.from(inputBuffer));
    stdin.end();
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetches the audio at previewUrl, runs Essentia.js feature extraction.
 * Returns null on ANY failure (network, decode, essentia crash). Never throws.
 * Caches successful results in audio_cache by spotifyId (results are stable per recording).
 */
export async function extractAudioFeatures(
  db: Database,
  spotifyId: string,
  previewUrl: string,
): Promise<AudioFeatures | null> {
  // 1. Cache check
  const cached = getAudioCache(db, spotifyId);
  if (cached !== null) return cached;

  try {
    // 2. Download
    let arrayBuffer: ArrayBuffer;
    try {
      const response = await fetch(previewUrl);
      if (!response.ok) {
        console.error(`[audio] fetch failed for ${spotifyId}: HTTP ${String(response.status)}`);
        return null;
      }
      arrayBuffer = await response.arrayBuffer();
    } catch (fetchErr) {
      console.error(`[audio] fetch error for ${spotifyId}:`, fetchErr);
      return null;
    }

    // 3. Decode via ffmpeg
    const pcm = await decodeWithFfmpeg(arrayBuffer);
    if (pcm === null || pcm.length === 0) {
      console.error(`[audio] ffmpeg decode returned empty/null for ${spotifyId}`);
      return null;
    }

    // 4. Run Essentia.js
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ess = getEssentia() as any;

    const signal = ess.arrayToVector(pcm) as unknown;

    // BPM
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const rhythmResult = ess.RhythmExtractor2013(signal) as { bpm: number };
    const bpm = Math.round(rhythmResult.bpm);

    // Key + scale
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const keyResult = ess.KeyExtractor(signal) as { key: string; scale: string };
    const key = keyResult.key;
    const scale = (keyResult.scale === 'major' ? 'major' : 'minor') as 'major' | 'minor';

    // Energy via RMS — typical music ~0.05–0.4, normalise against 0.3
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const rmsResult = ess.RMS(signal) as { rms: number };
    const energy = clamp01(rmsResult.rms / 0.3);

    // Danceability — Essentia returns 0–~30; divide by 3 and clamp
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const danceResult = ess.Danceability(signal) as { danceability: number };
    const danceability = clamp01(danceResult.danceability / 3);

    // mood values are heuristic proxies (Essentia TF mood models not in standard build)
    const happy = clamp01(
      0.5 * danceability +
      0.3 * (scale === 'major' ? 1 : 0) +
      0.2 * (bpm > 120 ? 1 : 0),
    );
    const sad = clamp01(
      0.5 * (1 - danceability) +
      0.3 * (scale === 'minor' ? 1 : 0) +
      0.2 * (bpm < 90 ? 1 : 0),
    );
    const aggressive = clamp01(
      0.5 * energy +
      0.3 * (bpm > 140 ? 1 : 0) +
      0.2 * (1 - danceability),
    );
    const relaxed = clamp01(
      0.5 * (1 - energy) +
      0.3 * (bpm < 100 ? 1 : 0) +
      0.2 * danceability,
    );

    const features: AudioFeatures = {
      bpm,
      key,
      scale,
      energy,
      danceability,
      mood: { happy, sad, aggressive, relaxed },
    };

    // 5. Cache
    setAudioCache(db, spotifyId, features);

    // 6. Return
    return features;
  } catch (err) {
    console.error(`[audio] unexpected error for ${spotifyId}:`, err);
    return null;
  }
}
