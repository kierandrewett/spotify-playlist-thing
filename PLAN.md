# Spotify Liked Songs → Auto-Categorised Playlists

## Context

You want a hands-off system: every track you like on Spotify gets automatically sorted into the right playlist(s) by genre / vibe / feeling, and unliked tracks vanish from those playlists. Liked Songs is the single source of truth — the playlists mirror it. You never think about it again.

The design is shaped by your constraints:

1. **Autism / ADHD-friendly = predictable structure, no decision load.** The taxonomy is fixed upfront in a config file. The LLM can only assign tracks to playlists you defined — it cannot invent new ones, cannot rename them, cannot move things around between runs. A track classified once is cached forever (unless you bump `taxonomy_version`), so the same song never bounces between playlists. Naming uses a consistent prefix (e.g. `🎧 `) so generated playlists are visually distinct in your sidebar from manual ones.

2. **Cheap model + rich input data.** The LLM gets a deeply enriched picture of each song. Sources:
   - **Spotify** — track metadata, ISRC, artist genres.
   - **Last.fm** — user-generated tags (`chill`, `melancholy`, `summer`, `gym`, `driving`) — exactly the vibe data we need.
   - **MusicBrainz** — backstop for genre tags when Last.fm is sparse (lookup by ISRC).
   - **Audio analysis** — we fetch the 30-second preview clip and run **Essentia.js** (WASM) over it to extract BPM, key, danceability, energy, mood probabilities. This replaces the deprecated Spotify audio-features endpoint and gives the LLM hard numerical signals.
   - **OpenRouter** routes the final classification call to a cheap model (recommended: `google/gemini-2.5-flash`).

3. **TypeScript / Node.js** throughout, deployed on **GitHub Actions cron**, state in a `state.sqlite` committed back to the repo.

## Critical 2026 API gotchas (verified via research)

These shape several decisions:

- **Spotify `audio-features` & `audio-analysis` are dead** for any new app (deprecated 27 Nov 2024). We replace them with on-the-fly Essentia.js analysis of preview clips.
- **Spotify `preview_url` is also mostly null for new apps.** When it's null, we fall back to the **iTunes Search API** (free, no auth, returns a 30s `previewUrl` for almost any track searchable by name + artist). This is the well-established workaround.
- **Spotify Feb 2026 migration**: `/me/tracks` PUT/DELETE → `/me/library`; `/playlists/{id}/tracks` → `/items`; search `limit` capped at 10. We write against the new endpoints from day one. Note `GET /me/tracks` still works for reading liked songs.
- **Spotify Dev Mode** caps your app to 5 allowlisted users (you only need 1 — yourself) and requires you keep Premium active.
- **MusicBrainz rate limit**: 1 request/sec. Must include a `User-Agent: app/version (contact)` header. We aggressively cache.

## Architecture

```
GitHub Actions cron (hourly)
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  src/sync.ts                                                 │
│   1. Refresh Spotify token                                   │
│   2. GET /me/tracks → current Liked Songs                    │
│   3. Diff vs state.sqlite                                    │
│        new   → enrich → classify → add to playlists          │
│        gone  → remove from playlists                         │
│   4. Commit state.sqlite back to repo                        │
└──────────────────────────────────────────────────────────────┘
        │
        ├── Spotify Web API           (OAuth refresh token)
        ├── Last.fm API               (user vibe tags)
        ├── MusicBrainz API           (genre tags via ISRC, 1 req/s)
        ├── iTunes Search API         (preview MP3 fallback, no auth)
        ├── Essentia.js (WASM)        (BPM, key, energy, danceability, mood)
        └── OpenRouter API            (cheap classifier model)
```

**State:** `state.sqlite` committed to the repo at the end of each run. Tiny (<1 MB for thousands of tracks). No external DB. Workflow uses a `concurrency` group so two runs never race.

**Cost (private repo):** GitHub Actions ~720 runs/month × ~30s steady-state = ~360 min (well under the 2000 min free tier; backfill day will spike to ~30 min for ~1000 tracks because of audio fetches and the MusicBrainz 1-req/s rate limit). LLM cost on Gemini 2.5 Flash via OpenRouter ≈ $0.10 for the entire backfill, then essentially free.

## Tech stack

- **Node.js 22+ / TypeScript** with `tsx` for direct execution (no build step needed).
- **`better-sqlite3`** — synchronous, zero-config, perfect for this.
- **Native `fetch`** — no `axios`/`got` needed.
- **`yaml`** — taxonomy config.
- **`openai` SDK pointed at OpenRouter** (`baseURL: 'https://openrouter.ai/api/v1'`) — model-agnostic, swap models via env var.
- **`essentia.js`** — WASM audio analysis. Runs in Node.
- **`ffmpeg`** — installed on the runner via `apt-get`; used to decode MP3 → PCM for Essentia.
- **`zod`** — validate LLM JSON output and config.
- **pnpm** — package manager (faster, cleaner lockfile than npm).

## Project layout

```
spotify-playlist-thing/
├── .github/workflows/sync.yml        # hourly cron, runs sync.ts, commits state.sqlite
├── src/
│   ├── sync.ts                       # entrypoint; orchestrates the diff + classify + apply
│   ├── spotify.ts                    # Spotify REST client (token refresh, liked songs, playlists)
│   ├── lastfm.ts                     # Last.fm tag fetcher
│   ├── musicbrainz.ts                # MusicBrainz lookup by ISRC + genre tags
│   ├── itunes.ts                     # iTunes Search API → preview_url fallback
│   ├── audio.ts                      # Essentia.js wrapper: download MP3, decode, extract features
│   ├── classifier.ts                 # OpenRouter call: enriched track data → playlist names
│   ├── state.ts                      # better-sqlite3 schema + queries
│   ├── taxonomy.ts                   # load + validate taxonomy.yaml
│   └── auth-bootstrap.ts             # one-time local script: OAuth flow → prints refresh token
├── taxonomy.yaml                     # YOUR fixed playlist definitions (the only thing you edit)
├── state.sqlite                      # committed state (created on first run)
├── package.json
├── tsconfig.json
├── pnpm-lock.yaml
├── .env.example                      # documents required env vars
└── README.md                         # setup steps
```

## The taxonomy file (the only thing you ever touch)

`taxonomy.yaml` is the heart of the system. You define your playlists once. Each entry tells the LLM exactly when to assign a track. Example shape:

```yaml
playlist_prefix: "🎧 "          # all generated playlists get this prefix in Spotify
max_playlists_per_track: 3      # caps clutter; LLM picks the top N matches
taxonomy_version: 1             # bump to force re-classification of all cached tracks
classifier_model: "google/gemini-2.5-flash"   # OpenRouter model slug; swap freely

playlists:
  - name: "Deep Focus"
    description: "Instrumental, low-vocal, low-stim. For coding or reading."
    fits: ["ambient", "lo-fi", "instrumental post-rock", "minimal techno"]
    audio_hints: { tempo: "<100 bpm", energy: "low", vocal: "low" }
    avoid: ["sudden dynamic shifts", "heavy vocals"]

  - name: "Hype"
    description: "High-energy, anthemic. For workouts, motivation."
    fits: ["upbeat hip-hop", "rock anthems", "EDM drops"]
    audio_hints: { tempo: ">120 bpm", energy: "high", danceability: "high" }

  - name: "Melancholy"
    description: "Sad, reflective, slow. For winding down or processing."
    fits: ["sad indie", "slow piano", "rainy day"]
    audio_hints: { mood: "sad", tempo: "<90 bpm" }

  # ... add as many as you like; suggested 12-20 to start
```

Edit the file → next sync respects it. Bumping `taxonomy_version` clears the classification cache and re-runs everything.

## Key components

### `src/spotify.ts`
- `refreshAccessToken(refreshToken)` — POST to `/api/token`.
- `getLikedTracks()` — paginates `GET /me/tracks` (50/page); returns `{id, name, artists, album, isrc, preview_url, added_at}`. ISRC comes from `external_ids.isrc`.
- `getArtistGenres(artistIds)` — batches `GET /artists?ids=…` (50/call).
- `getOrCreatePlaylist(name)` — searches user's playlists for `prefix + name`; creates private if missing. Caches `spotify_playlist_id` in state DB.
- `addTracksToPlaylist(playlistId, uris)` — `POST /playlists/{id}/items` (Feb 2026 endpoint, batches of 100).
- `removeTracksFromPlaylist(playlistId, uris)` — `DELETE /playlists/{id}/items`.

### `src/lastfm.ts`
- `getTrackTags(artist, track)` — `track.getTopTags`; returns top ~10 tags with weights. Falls back to `artist.getTopTags`. Cached indefinitely in `lastfm_cache` table (tags are stable).

### `src/musicbrainz.ts`
- `lookupByISRC(isrc)` → `GET /isrc/{isrc}?inc=tags+genres` returns recording with genre tags. Includes `User-Agent: spotify-playlist-thing/1.0 (your-email)` (MB requirement).
- A simple in-process token-bucket throttler at 1 req/sec. Cached in `musicbrainz_cache` table.

### `src/itunes.ts`
- `getPreviewUrl(artist, track)` — `GET https://itunes.apple.com/search?term=…&entity=song&limit=1` → returns `previewUrl` (30s AAC clip). No auth, no rate limit problems for our scale. Used only when Spotify's `preview_url` is null.

### `src/audio.ts`
- `extractFeatures(previewUrl)`:
  1. `fetch(previewUrl)` → buffer.
  2. `ffmpeg -i - -f wav -ar 22050 -ac 1 -` (via `child_process`) → mono PCM.
  3. Load Essentia.js once at module init; run extractors: `RhythmExtractor2013` (BPM), `KeyExtractor` (key + scale), `Energy`, `Danceability`, `MusicExtractor` mood probabilities.
  4. Return `{ bpm, key, scale, energy, danceability, mood: {happy, sad, aggressive, relaxed} }`.
- Wrapped in try/catch — if anything fails (audio missing, ffmpeg error, essentia crash), returns `null` and the classifier proceeds without audio features. Never blocks the pipeline.
- Result cached in `audio_cache` table forever (audio of a recording doesn't change).

### `src/classifier.ts`
- `classify(enriched, taxonomy) → string[]` where `enriched` bundles track metadata + Spotify genres + Last.fm tags + MusicBrainz tags + audio features.
- Uses `openai` SDK pointed at OpenRouter:
  ```ts
  new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  })
  ```
- Prompt structure:
  - **System**: "You categorise songs into a fixed list of playlists. Return JSON `{playlists: string[]}`. Pick at most N. Use ONLY names from the provided list. Be conservative — if a track doesn't strongly fit a playlist, omit it. Empty array is valid."
  - **User**: track name + artists + album + release year + Spotify artist genres + Last.fm tags (top 10 with weights) + MusicBrainz genres + audio features block (BPM, key, energy, danceability, mood probs) + the full taxonomy serialised.
- `temperature: 0`, `response_format: { type: 'json_object' }`. Output validated with `zod` and intersected with the taxonomy as a safety check (drops any hallucinated names).

### `src/state.ts` — better-sqlite3 schema
```sql
CREATE TABLE tracks (
  spotify_id TEXT PRIMARY KEY,
  name TEXT, artists TEXT, album TEXT, isrc TEXT,
  added_at TEXT,                         -- when liked
  classified_at TEXT,                    -- when LLM ran
  taxonomy_version INTEGER,              -- if mismatch, re-classify
  removed_at TEXT                        -- soft-delete on unlike
);
CREATE TABLE classifications (
  spotify_id TEXT, playlist_name TEXT,
  PRIMARY KEY (spotify_id, playlist_name)
);
CREATE TABLE playlists (
  name TEXT PRIMARY KEY,                 -- taxonomy name (no prefix)
  spotify_playlist_id TEXT
);
CREATE TABLE lastfm_cache    (spotify_id TEXT PRIMARY KEY, tags_json TEXT, fetched_at TEXT);
CREATE TABLE musicbrainz_cache (isrc TEXT PRIMARY KEY, tags_json TEXT, fetched_at TEXT);
CREATE TABLE audio_cache     (spotify_id TEXT PRIMARY KEY, features_json TEXT, fetched_at TEXT);
```

### `src/sync.ts` — the loop
1. Refresh access token.
2. `current = new Set(await spotify.getLikedTracks())`; `previous = state.allTrackedIds()`.
3. **New tracks** (`current - previous`):
   - Concurrent enrichment (Promise.all per track, but MusicBrainz throttled global): Spotify artists → Last.fm tags → MusicBrainz lookup → preview URL (Spotify or iTunes fallback) → Essentia features.
   - Call classifier.
   - For each returned playlist name, get-or-create the Spotify playlist and add the track.
   - Insert into `tracks` + `classifications`.
4. **Removed tracks** (`previous - current` and not already `removed_at`):
   - For each row in `classifications`, batch `removeTracksFromPlaylist`.
   - Mark `removed_at`. Re-liking → fresh classification on the next run.
5. **Re-classification**: tracks where `taxonomy_version < taxonomy.taxonomy_version` → wipe their `classifications`, re-classify, re-apply playlists.
6. Commit `state.sqlite` (workflow does `git add state.sqlite && git commit && git push`).

Logs are structured (one JSON line per track) so the workflow run is greppable.

### `.github/workflows/sync.yml`
- Triggers: `schedule: '0 * * * *'` + `workflow_dispatch`.
- `concurrency: { group: sync, cancel-in-progress: false }`.
- Steps:
  1. `actions/checkout@v4`
  2. `pnpm/action-setup@v4`
  3. `actions/setup-node@v4` (Node 22)
  4. `sudo apt-get install -y ffmpeg` (for Essentia decoding)
  5. `pnpm install --frozen-lockfile`
  6. `pnpm tsx src/sync.ts`
  7. Commit `state.sqlite` if changed (use `stefanzweifel/git-auto-commit-action` or a 3-line bash step).
- Secrets: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, `LASTFM_API_KEY`, `OPENROUTER_API_KEY`, `MUSICBRAINZ_CONTACT_EMAIL`.
- Heads-up: GitHub disables scheduled workflows after 60 days of repo inactivity. The hourly state commits naturally count as activity, so this won't trigger.

## Setup (one-time)

1. **Create a Spotify dev app** at developer.spotify.com → note Client ID + Secret. Add `http://127.0.0.1:8888/callback` as a redirect URI. Add your own Spotify email to the user allowlist (Dev Mode max 5).
2. **Get a Last.fm API key** — free, instant at last.fm/api/account/create.
3. **Get an OpenRouter API key** — load $5; will last years.
4. **Run the bootstrap once locally**: `pnpm tsx src/auth-bootstrap.ts` opens browser, you log in, it prints your Spotify refresh token. Copy it.
5. **Add 6 secrets** to the GitHub repo (Settings → Secrets and variables → Actions).
6. **Edit `taxonomy.yaml`** with your playlists.
7. **Push.** First Actions run backfills everything (will take ~30 min for ~1000 tracks because of MusicBrainz rate limit + audio downloads); subsequent hourly runs are ~30 seconds.

## Critical files to create

- `src/sync.ts` — orchestrator
- `src/spotify.ts` — REST client (uses Feb 2026 endpoints: `/me/library`, `/playlists/{id}/items`)
- `src/lastfm.ts`, `src/musicbrainz.ts`, `src/itunes.ts` — metadata enrichment
- `src/audio.ts` — Essentia.js wrapper with ffmpeg decoding
- `src/classifier.ts` — OpenRouter call
- `src/state.ts` — better-sqlite3 layer
- `src/taxonomy.ts` — yaml loader + zod schema
- `src/auth-bootstrap.ts` — one-time interactive OAuth helper
- `taxonomy.yaml` — your playlist definitions
- `.github/workflows/sync.yml` — the cron
- `package.json`, `tsconfig.json`, `.env.example`, `README.md`

## Verification

- **Dry-run mode**: `pnpm tsx src/sync.ts --dry-run` prints what would be added/removed/classified without hitting Spotify writes. Use this on first run.
- **Single-track debug**: `pnpm tsx src/sync.ts --debug-track <spotify-id>` runs full enrichment + classification for one track and prints the prompt + raw LLM response. Use when a song lands in the wrong playlist.
- **Backfill check**: after first real run, open Spotify and verify a handful of `🎧 *` playlists exist with sensible track assignments. Spot-check 10 random songs against your gut feeling.
- **Diff loop test**: like a new song on Spotify → manually trigger the workflow (`workflow_dispatch`) → confirm it appears in the right playlists within ~1 min. Then unlike it, re-trigger, confirm it disappears.
- **Determinism test**: re-run with no changes → should be a no-op (no API writes, no commit).
- **Taxonomy bump test**: edit a playlist's `description`, bump `taxonomy_version`, run → verify all classifications regenerate.
- **Audio fallback test**: pick a track where Spotify's `preview_url` is null (most of them in 2026); confirm the iTunes fallback succeeds and Essentia features make it into the LLM prompt.
- **Cost check**: after backfill, check OpenRouter dashboard — should be cents, not dollars. If it's dollars, the prompt is too fat; trim taxonomy fields or drop redundant tag sources.
