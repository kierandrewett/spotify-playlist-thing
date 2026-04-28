/**
 * iTunes Search API client — provides a 30-second AAC preview URL as a
 * fallback when Spotify's preview_url is null (which is common for new apps
 * in 2026).
 *
 * No auth required. No caching here — src/audio.ts caches extracted features.
 *
 * Rate limiting: iTunes Search has an undocumented limit (~20 req/min). We
 * throttle to one request every 3 seconds globally and retry once on 429.
 */

interface ItunesSearchResult {
  trackName: string;
  artistName: string;
  previewUrl?: string;
}

interface ItunesSearchResponse {
  resultCount: number;
  results: ItunesSearchResult[];
}

const MIN_INTERVAL_MS = 3000;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function fetchOnce(url: string): Promise<Response> {
  await throttle();
  return fetch(url, {
    headers: { 'User-Agent': 'spotify-playlist-thing/1.0' },
  });
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/**
 * Returns the URL to a 30-second AAC preview clip, or null if no good match
 * is found. Searches iTunes by "{artist} {track}" and returns the first
 * matching song's previewUrl. Retries on 5xx / 429 / network errors.
 */
export async function getItunesPreviewUrl(
  artist: string,
  track: string,
): Promise<string | null> {
  const term = encodeURIComponent(`${artist} ${track}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchOnce(url);

      if (response.ok) {
        const data = (await response.json()) as ItunesSearchResponse;
        if (data.resultCount === 0 || data.results.length === 0) return null;
        return data.results[0].previewUrl ?? null;
      }

      if (TRANSIENT_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** (attempt - 1);
        console.error(
          `[itunes] transient ${response.status} for "${artist} - ${track}", retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_ATTEMPTS - 1})`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      throw new Error(
        `iTunes Search API returned HTTP ${response.status} for "${artist} - ${track}"`,
      );
    } catch (err) {
      const isNetworkError =
        err instanceof TypeError ||
        (err instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(err.message));
      if (isNetworkError && attempt < MAX_ATTEMPTS) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        console.error(
          `[itunes] network error for "${artist} - ${track}", retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_ATTEMPTS - 1}): ${String(err)}`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error(`iTunes Search exhausted retries for "${artist} - ${track}"`);
}
