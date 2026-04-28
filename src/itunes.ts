/**
 * iTunes Search API client — provides a 30-second AAC preview URL as a
 * fallback when Spotify's preview_url is null (which is common for new apps
 * in 2026).
 *
 * No auth required. No caching here — src/audio.ts caches extracted features.
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

/**
 * Returns the URL to a 30-second AAC preview clip, or null if no good match
 * is found. Searches iTunes by "{artist} {track}" and returns the first
 * matching song's previewUrl.
 */
export async function getItunesPreviewUrl(
  artist: string,
  track: string,
): Promise<string | null> {
  const term = encodeURIComponent(`${artist} ${track}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'spotify-playlist-thing/1.0' },
  });

  if (!response.ok) {
    throw new Error(
      `iTunes Search API returned HTTP ${response.status} for "${artist} - ${track}"`,
    );
  }

  const data = (await response.json()) as ItunesSearchResponse;

  if (data.resultCount === 0 || data.results.length === 0) {
    return null;
  }

  const first = data.results[0];
  return first.previewUrl ?? null;
}
