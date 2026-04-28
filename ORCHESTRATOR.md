# ORCHESTRATOR

A runbook for building this project by spawning **multiple opencode agents** running **Kimi K2.6** in parallel **git worktrees**, one per module. Each agent owns a single file (or tightly-related set of files). Worktrees keep them from stepping on each other; a shared **interface contract** keeps their outputs composable.

> Read **`PLAN.md`** first. This document is *how* to build it; PLAN.md is *what* to build.

---

## The model

- **Wave-based execution.** Modules are grouped into waves by their dependency graph. A wave finishes (every PR merged to `main`) before the next wave starts. Inside a wave, every agent runs in parallel.
- **One worktree per agent.** Isolation prevents file-write races and lets each agent run a long opencode session without colliding on `pnpm install` etc.
- **One module per agent.** Bounded scope = better Kimi K2.6 output, easier review, smaller blast radius.
- **Interface-first.** Wave 0 defines `src/types.ts` and the SQLite schema. Every later agent imports from `src/types.ts` and reads/writes via `src/state.ts`. Nobody invents their own data shapes.
- **You are the integrator.** After each wave you review diffs, run the test command for that module, and merge. Kimi proposes; you dispose.

---

## Dependency graph (the work breakdown)

```
WAVE 0 — Foundation (1 agent, sequential)
  └── scaffold + src/types.ts + src/state.ts + src/taxonomy.ts
        │
        ▼
WAVE 1 — Leaf modules (6 agents, all parallel)
  ├── src/spotify.ts
  ├── src/lastfm.ts
  ├── src/musicbrainz.ts
  ├── src/itunes.ts
  ├── src/audio.ts
  └── src/auth-bootstrap.ts
        │
        ▼
WAVE 2 — Composers (2 agents, parallel)
  ├── src/classifier.ts
  └── src/sync.ts            (depends on classifier + every wave-1 module via interfaces)
        │
        ▼
WAVE 3 — Ops + UX (1 agent)
  └── .github/workflows/sync.yml + README.md + .env.example + sample taxonomy.yaml
```

**Why src/sync.ts is in wave 2 alongside classifier**: it depends on the wave-1 modules but only via the interfaces declared in `src/types.ts`. As long as wave 1 honours those interfaces, sync.ts can be written in parallel with classifier.ts. If you want maximum safety, push sync.ts to its own wave 2.5 — it's a 30-minute slowdown for guaranteed correctness.

---

## Setup: one-time per machine

You already have **opencode 1.3.17** installed and the **OpenCode Go** provider authed (verified via `opencode providers list`). The model slug is **`opencode-go/kimi-k2.6`** — confirmed available via `opencode models | grep kimi`.

```bash
# Sanity-check auth
opencode providers list                       # OpenCode Go should show as authed
opencode models | grep kimi                   # should list opencode-go/kimi-k2.6

# Per-agent prompt directory
mkdir -p .agents/runs
```

> Every wave below passes the model explicitly via `-m opencode-go/kimi-k2.6`. If you want it as the default, add it to a project config: `echo '{"model":"opencode-go/kimi-k2.6"}' > opencode.json`.
>
> **Note on the runtime app's LLM provider.** The *built app's* classifier still calls **OpenRouter** at runtime (per `PLAN.md`) — that's a separate concern from this build-time orchestration. You'll need an `OPENROUTER_API_KEY` GitHub Actions secret when you ship, but you don't need it locally to *build* the project with opencode.

---

## Per-agent brief files

Each agent gets its own brief at `.agents/<module>.md`. The brief is **completely self-contained** — Kimi sees only its brief, `PLAN.md`, `src/types.ts`, and (for wave 2+) the already-merged earlier waves. It never sees this orchestrator file.

A brief follows this template:

```markdown
# Agent: <module>

## Role
You are implementing exactly one file: `src/<module>.ts`. Do not modify any other file.

## Read first
- `PLAN.md` (project overview)
- `src/types.ts` (interface contract — your output MUST match)
- `src/state.ts` (only the cache table relevant to you, if any)

## Deliverable
[Exact functions to export, signatures from types.ts, behavioural requirements
copied verbatim from the matching subsection of PLAN.md → "Key components"]

## Constraints
- TypeScript strict mode; no `any`.
- Native fetch; no axios/got.
- Throw on unexpected API errors; let the caller decide whether to swallow.
- Cache via the `state.ts` helpers — never touch sqlite directly.
- All public exports MUST be importable as `import { … } from './<module>.js'`.

## Done when
- `pnpm tsc --noEmit` passes.
- `pnpm tsx scripts/smoke-<module>.ts` succeeds against a real API call (you write the smoke script).
- Code under 250 lines; if longer, split into helpers in the same file.

## Out of scope
[List modules this agent must NOT touch — usually everything except its own file.]
```

The complete set of briefs is generated once and committed under `.agents/`. See [Generating the briefs](#generating-the-briefs) below.

---

## Wave 0 — Foundation (sequential, one agent)

**Why sequential:** every later wave imports from these files. They are the contract.

```bash
git worktree add worktrees/wt-foundation -b feat/foundation
cd worktrees/wt-foundation

opencode run -m opencode-go/kimi-k2.6 "$(cat <<'EOF'
You are bootstrapping the spotify-playlist-thing project. Read PLAN.md.

Deliver in a single PR:
1. package.json (Node 22+, type: module, scripts: { sync, bootstrap, typecheck }),
   pnpm-lock.yaml via `pnpm install`. Deps: better-sqlite3, yaml, openai, zod, essentia.js.
   Dev deps: typescript, tsx, @types/node, @types/better-sqlite3.
2. tsconfig.json — strict, ESNext, NodeNext modules, no emit (we run via tsx).
3. .env.example documenting all required env vars (see PLAN.md → Setup).
4. .gitignore (node_modules, .env, *.log, worktrees/, .agents/runs/).
5. src/types.ts — exhaustive interface definitions:
     SpotifyTrack, SpotifyArtist, EnrichedTrack, AudioFeatures,
     LastfmTag, MusicbrainzTags, TaxonomyEntry, TaxonomyConfig,
     ClassificationResult.
   These are the contracts every other agent will import.
6. src/state.ts — better-sqlite3 wrapper. Schema exactly per PLAN.md.
   Export: openDb, allTrackedIds, upsertTrack, recordClassifications,
   markRemoved, getClassifications, get/setLastfmCache, get/setMusicbrainzCache,
   get/setAudioCache, get/setPlaylistMapping, currentTaxonomyVersion.
7. src/taxonomy.ts — load + zod-validate taxonomy.yaml; export load(): TaxonomyConfig.

Do NOT implement any other src/ file. Do NOT write to .github/, README.md, or taxonomy.yaml
(those come in wave 3, except a placeholder taxonomy.yaml.example for reference).
EOF
)"
```

When opencode finishes:

```bash
pnpm tsc --noEmit
git add -A && git commit -m "wave 0: scaffold + types + state + taxonomy loader"
git push -u origin feat/foundation
gh pr create --fill && gh pr merge --squash --delete-branch
cd ../..
git worktree remove worktrees/wt-foundation
git checkout main && git pull
```

---

## Wave 1 — Leaf modules (parallel, six agents)

After wave 0 lands on `main`, fan out. Run all six in separate terminal panes (or background them — see [Parallel execution](#parallel-execution-tip) below).

```bash
for module in spotify lastfm musicbrainz itunes audio auth-bootstrap; do
  branch="feat/$module"
  wt="worktrees/wt-$module"
  git worktree add "$wt" -b "$branch"
  (
    cd "$wt"
    opencode run -m opencode-go/kimi-k2.6 "$(cat ../../.agents/$module.md)" \
      2>&1 | tee "../../.agents/runs/$module-$(date +%s).log"
  ) &
done
wait    # block until all six agents finish
```

After all six complete: review and merge each PR independently. They touch disjoint files (`src/spotify.ts`, `src/lastfm.ts`, …) so there are no merge conflicts.

```bash
for module in spotify lastfm musicbrainz itunes audio auth-bootstrap; do
  cd "worktrees/wt-$module"
  pnpm tsc --noEmit && pnpm tsx "scripts/smoke-$module.ts"   # smoke test the agent wrote
  git push -u origin "feat/$module"
  gh pr create --fill
  cd ../..
done

# Review each PR. Then merge in any order (no conflicts):
for module in spotify lastfm musicbrainz itunes audio auth-bootstrap; do
  gh pr merge "feat/$module" --squash --delete-branch
  git worktree remove "worktrees/wt-$module"
done
git checkout main && git pull
```

**Critical review checks before merging a wave-1 PR:**
- All exports match the signatures in `src/types.ts`.
- No imports from sibling wave-1 modules (`spotify.ts` must not import from `lastfm.ts`).
- API keys read from `process.env`, never hardcoded.
- Caching always goes through `state.ts` — no raw `sqlite3` calls.
- No swallowed errors that hide auth failures.

---

## Wave 2 — Composers (parallel, two agents)

```bash
for module in classifier sync; do
  git worktree add "worktrees/wt-$module" -b "feat/$module"
  (
    cd "worktrees/wt-$module"
    opencode run -m opencode-go/kimi-k2.6 "$(cat ../../.agents/$module.md)" \
      2>&1 | tee "../../.agents/runs/$module-$(date +%s).log"
  ) &
done
wait
```

`sync.ts` imports from every wave-1 module + `classifier.ts`, but only via their typed exports. Because the contract was frozen in wave 0, sync.ts and classifier.ts can be written truly in parallel.

Merge `classifier` first, then rebase + merge `sync` (in case Kimi's import path for the classifier changed).

---

## Wave 3 — Ops + UX (one agent)

```bash
git worktree add worktrees/wt-ops -b feat/ops
cd worktrees/wt-ops
opencode run -m opencode-go/kimi-k2.6 "$(cat ../../.agents/ops.md)"
```

Deliverables:
- `.github/workflows/sync.yml` (per PLAN.md exactly).
- `README.md` (setup walkthrough copying PLAN.md → "Setup (one-time)").
- `taxonomy.yaml` with 12 starter playlists tuned for autism/ADHD use (Deep Focus, Hype, Melancholy, Nostalgia, Body Doubling, Hyperfocus Loop, Decompression, Joy, Anger Out, Cosy, Driving, Curiosity Spark — agent will workshop these).
- Final smoke test: `pnpm sync --dry-run` runs end-to-end with mock secrets and prints what it would do.

---

## Generating the briefs

Run this once after PLAN.md is final and before wave 1. Each brief gets the same structure but a different "Deliverable" section sliced from PLAN.md.

```bash
mkdir -p .agents/runs

# Use opencode itself (or any LLM) to slice PLAN.md into briefs.
# Run from the repo root:
opencode run -m opencode-go/kimi-k2.6 "$(cat <<'EOF'
Read PLAN.md and ORCHESTRATOR.md. For each module listed in ORCHESTRATOR.md
(spotify, lastfm, musicbrainz, itunes, audio, auth-bootstrap, classifier, sync, ops),
generate a self-contained brief at .agents/<module>.md following the template
in ORCHESTRATOR.md → "Per-agent brief files".

Each brief MUST:
- Reference only PLAN.md and src/types.ts as inputs.
- List the exact exports + signatures the module must provide.
- List which files the agent is forbidden from touching.
- Include a smoke-test command the agent must make pass.

Do NOT generate code, only the .agents/*.md briefs.
EOF
)"

# Sanity-check the briefs before unleashing wave 1.
ls .agents/*.md
```

Commit the briefs to `main` so every worktree can read them.

---

## Parallel execution tip

The `&` + `wait` pattern above runs agents concurrently in the same shell. For better visibility, use **tmux** with one pane per agent:

```bash
tmux new-session -d -s build
for module in spotify lastfm musicbrainz itunes audio auth-bootstrap; do
  tmux new-window -t build -n "$module" \
    "cd worktrees/wt-$module && opencode run -m opencode-go/kimi-k2.6 \"$(cat ../../.agents/$module.md)\""
done
tmux attach -t build
```

Or with **GNU parallel** if you prefer machine-readable logs:

```bash
parallel --jobs 6 --tag --line-buffer \
  'cd worktrees/wt-{} && opencode run -m opencode-go/kimi-k2.6 "$(cat ../../.agents/{}.md)"' \
  ::: spotify lastfm musicbrainz itunes audio auth-bootstrap
```

---

## Cost & time budget

| Wave | Agents | Wall time | Approx Kimi K2.6 cost |
|------|--------|-----------|------------------------|
| 0    | 1      | ~10 min   | ~$0.05                 |
| 1    | 6      | ~15 min (parallel) | ~$0.30        |
| 2    | 2      | ~10 min (parallel) | ~$0.10        |
| 3    | 1      | ~5 min    | ~$0.03                 |
| **Total** | **10 runs** | **~40 min wall, ~50 min agent-time** | **~$0.50** |

Numbers assume Kimi K2.6 via OpenRouter at current pricing. A single human review pass between waves adds 10–20 min each.

---

## Failure modes & recovery

- **Agent stalls or loops.** Kill the opencode process, inspect its log under `.agents/runs/`, tighten the brief's "Done when" criteria, retry in the same worktree (it will see its own partial work).
- **Type mismatch with `src/types.ts`.** Means the brief was ambiguous OR Kimi ignored it. Fix the brief, blow away the worktree (`git worktree remove --force`), re-run.
- **Two wave-1 agents disagree about cache key format.** Should be impossible if both go through `state.ts` — if it happens, the wave-0 `state.ts` is missing helpers; bump it back to wave 0 and rebuild the affected wave-1 modules.
- **Kimi proposes adding a dep that isn't in `package.json`.** Reject in review; deps are frozen in wave 0. If genuinely needed, add it as a follow-up PR after the affected wave merges.

---

## When to abandon orchestration and just write it yourself

This is a small project (~10 files, ~1500 LOC). The orchestration overhead pays off if:
- You enjoy the parallelism for its own sake, or
- You want a reproducible "AI built this" demo.

If you just want the thing built, a single Claude Code or opencode session writing all files sequentially will finish in ~20 minutes with one review pass. **The orchestration model in this doc is the right shape for projects 5–10× this size.** Use it here as a small-scale rehearsal.
