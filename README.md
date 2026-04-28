# spotify-playlist-thing

Automatically sorts your Spotify Liked Songs into playlists based on genre, vibe, and mood — using Last.fm tags, MusicBrainz genres, Essentia.js audio analysis, and an LLM classifier. The taxonomy is defined once in a config file; the system never invents new playlists, never renames existing ones, and never moves a classified track between runs unless you explicitly bump the version. Designed for autism/ADHD use: predictable structure, no decision load, no surprises.

## How it works

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

State lives in `state.sqlite`, committed back to the repo at the end of each run. No external database. The workflow uses a concurrency group so two runs never race.

## Setup

### 1. Create a Spotify developer app

Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create an app.

- Note your **Client ID** and **Client Secret** from the app settings.
- Under **Redirect URIs**, add: `http://127.0.0.1:8888/callback`
- Under **User Management**, add your own Spotify email address to the allowlist. (Dev Mode caps you at 5 allowlisted users — you only need yourself.)

Required OAuth scopes (set these in the app settings or accept the defaults — the bootstrap script requests them explicitly):
`user-library-read`, `playlist-read-private`, `playlist-modify-private`, `playlist-modify-public`

### 2. Get a Last.fm API key

Free and instant: [last.fm/api/account/create](https://www.last.fm/api/account/create)

### 3. Get an OpenRouter API key

Sign up at [openrouter.ai](https://openrouter.ai) and add $5 credit — at Gemini 2.5 Flash prices this will last years at this usage level.

### 4. Install dependencies

```sh
pnpm install
```

### 5. Create your `.env` file

```sh
cp .env.example .env
```

Fill in all six values:

| Variable | Where to get it |
|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify app dashboard |
| `SPOTIFY_CLIENT_SECRET` | Spotify app dashboard |
| `SPOTIFY_REFRESH_TOKEN` | Step 6 below |
| `LASTFM_API_KEY` | Last.fm API account |
| `OPENROUTER_API_KEY` | OpenRouter dashboard |
| `MUSICBRAINZ_CONTACT_EMAIL` | Your own email (required by MusicBrainz API policy) |

### 6. Get your Spotify refresh token

Run the bootstrap script once — it opens your browser, you authorise the app, and it prints a long-lived refresh token:

```sh
pnpm bootstrap
```

Copy the printed token into `.env` as `SPOTIFY_REFRESH_TOKEN`.

### 7. Add secrets to GitHub

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Add all six secrets (same names as the `.env` keys):

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN`
- `LASTFM_API_KEY`
- `OPENROUTER_API_KEY`
- `MUSICBRAINZ_CONTACT_EMAIL`

### 8. Edit `taxonomy.yaml`

`taxonomy.yaml` defines your playlists. Each entry becomes a Spotify playlist named `🎧 <name>`. The file ships with 12 playlists tuned for ND use — read through them and remove or adjust any that don't fit.

The structure:

```yaml
playlist_prefix: "🎧 "        # prefix for all managed playlists in Spotify
max_playlists_per_track: 3    # how many playlists one song can appear in
taxonomy_version: 1           # bump to force re-classification of all tracks

playlists:
  - name: "Deep Focus"
    description: "..."        # the LLM reads this — write for the model
    fits:                     # genre/vibe tags that strongly indicate this playlist
      - "ambient"
      - "lo-fi"
    audio_hints:              # optional: numeric guidance from Essentia analysis
      tempo: "<100 bpm"
      energy: "low"
    avoid:                    # optional: qualities that disqualify a track
      - "heavy vocals"
```

See the inline comments in `taxonomy.yaml` for more detail.

### 9. Push to GitHub

```sh
git add .
git commit -m "initial setup"
git push
```

The first Actions run will backfill all your current Liked Songs. This takes roughly 30 minutes for ~1000 tracks due to the MusicBrainz 1-request/second rate limit and audio downloads. Subsequent hourly runs take ~30 seconds.

## Daily use

There is no daily use — that's the point. Like a song on Spotify and it will appear in the right playlists within the hour. Unlike it and it disappears from all playlists by the next run.

## Customising

Edit `taxonomy.yaml` at any time — changes take effect on the next sync.

If you restructure playlists significantly (rename entries, tighten descriptions, change what fits where), bump `taxonomy_version`:

```yaml
taxonomy_version: 2   # was 1
```

This clears the classification cache and re-runs the LLM over every tracked track on the next sync. It does not re-fetch audio or Last.fm data (those caches are separate and persist indefinitely).

## Useful commands

```sh
# Run a full sync locally — hits real Spotify APIs and makes real writes
pnpm sync

# Preview what would happen — reads Liked Songs and classifies, no Spotify writes
pnpm dry-run

# Debug a single track end-to-end: prints enriched data + LLM classification
pnpm tsx src/sync.ts --debug-track <spotify-track-id>

# TypeScript compile check (no output = clean)
pnpm typecheck
```

The `--debug-track` command is especially useful when a song lands in the wrong playlist. Run it, read the `EnrichedTrack` output to see what data the LLM received, then read `ClassificationResult` to see its reasoning. Adjust the relevant taxonomy entries and bump `taxonomy_version`.

## Cost

**Backfill** (first run, ~1000 tracks): roughly **$0.10** in LLM costs on Gemini 2.5 Flash via OpenRouter. GitHub Actions time is ~30 minutes, well within the 2000 min/month free tier.

**Steady state** (hourly runs, a handful of new likes per day): effectively **free** — a few cents per month at most. Each run is ~30 seconds of Actions time.

## Troubleshooting

**Songs not appearing in playlists**
- Check the **Actions** tab on GitHub — look at the most recent workflow run logs for errors.
- Verify all 6 secrets are set correctly (Settings → Secrets and variables → Actions).
- Trigger a manual run: Actions tab → "sync" workflow → "Run workflow" button.

**Song landed in the wrong playlist**
- Run `pnpm tsx src/sync.ts --debug-track <spotify-id>` to see exactly what data the LLM received and what it decided.
- Either accept the classification (the LLM may have seen something you didn't), or make the relevant taxonomy entry more specific and bump `taxonomy_version` to force re-classification.

**"Spotify Dev Mode user limit" error**
- Only you need to be in the allowlist. Go to your Spotify app → User Management and confirm your own email is listed. Dev Mode allows up to 5 users; for personal use you only ever need 1.

**Scheduled workflow stops running**
- GitHub disables scheduled workflows after 60 days of repo inactivity. In practice the hourly `state.sqlite` commits count as activity, so this shouldn't trigger. If it does, re-enable from the Actions tab.

## Acknowledgements

- [Last.fm API](https://www.last.fm/api) — user-generated tags (the "vibe data" that makes classification accurate)
- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API) — curated genre tags via ISRC lookup
- [Essentia.js](https://essentia.upf.edu/essentiajs) — open-source audio analysis running in Node via WASM
