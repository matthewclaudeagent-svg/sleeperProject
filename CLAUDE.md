# Working on this repo

Context for Claude Code. Read this before making changes.

## What this is

A static fantasy football dashboard for a 12-team Sleeper league played among
coworkers. GitHub Actions rebuilds `data.json` hourly; GitHub Pages serves it.

The site is public, so keep real-world identifying detail out of it: no employer,
no full names, nothing tying the managers to where they work.

Read `README.md` for setup and the full feature list. This file covers how to
work on the code.

## Architecture rules

**All computation lives in `build.js`. The page renders, it does not calculate.**
If you find yourself writing math in `index.html`, it belongs in the build script
and should be written into `data.json` instead. The only exception is the live
score section, which fetches Sleeper directly because an hourly cron can't cover
Sunday afternoon.

**No dependencies.** Both files are plain JavaScript, no build step, no bundler,
no framework, no CSS library. Node 20's built-in `fetch` covers all HTTP. Adding
a package means adding `npm install` to the workflow and a lockfile to the repo —
don't, unless there's no reasonable alternative, and say so first if there isn't.

**No backend.** This is a static site. Anything requiring a write from a visitor
— polls, voting, comments, a trash talk board — cannot be built here without
adding hosting and cost. If asked for one of those, say so rather than
scaffolding something that can't deploy.

**Single file per concern.** `index.html` holds its own CSS and JS on purpose.
Don't split it into separate files; it's one page and the whole thing is under
900 lines.

## Constraints you can't see from the code

**The Sleeper player endpoint is rate-limited by etiquette, not by API.**
`/players/nfl` is about 5MB and Sleeper asks that it be called at most once a
day. `loadPlayers()` caches it in `players.json` keyed by date. Don't remove that
cache or call the endpoint anywhere else.

**Recaps are write-once.** `buildRecaps()` reads the existing `data.json`, and
returns early if the current week already has a recap. This is what stops the
hourly cron from re-billing the Anthropic API 24 times a day for the same week.
If you change recap logic, preserve that guard.

**The workflow skips the commit when nothing changed.** Keep that. Otherwise the
repo gets 24 empty commits a day.

**The greedy lineup solver is correct only because there's one FLEX.** Filling
dedicated slots with the top scorer at each position and then taking the best
remaining flex-eligible player is provably optimal for this roster shape. It is
not optimal for superflex or multi-flex leagues. If the league settings change,
this needs a real assignment algorithm.

## Design

The palette is defined as CSS custom properties at the top of `index.html`:

| Token | Light | Dark |
| --- | --- | --- |
| `--ink` | `#201747` Valhalla | `#ECE9F8` |
| `--cyan` | `#00A2C7` | `#2DC6F2` |
| `--bright` | `#2DC6F2` Picton | `#66DBFF` |
| `--rose` | `#D64570` | `#FF6B9D` |

Typeface is Archivo, one family, using its width axis — headings wide at 700,
body at normal width. Figures are tabular throughout.

Two rules worth keeping: **magenta means bad** (bench points, fewest points) and
nothing else uses it, so the eye finds the embarrassing number. And **no
all-caps labels, no monospace** — both read as generic dashboard chrome.

Mobile-first. The tab bar exists so the phone view isn't endless scrolling, since
that's where most people will open it.

## Testing

There's no test suite. Verify changes by running the real thing:

```bash
node build.js && npx serve .
```

`build.js` exports `bestLineup`, `positionalNeed`, and `suggestTrades` for
ad-hoc testing — `main()` is guarded by `require.main === module`, so requiring
the file doesn't trigger a build.

The solver has a known-good case: a roster scoring QB 22, RB 25/18/9, WR 30/14/11,
TE 8, K 7, DEF 12 has an optimal lineup of **147**, correctly benching the 9-point
RB and the 6-point WR.

## Open questions

- **Live polling CORS is unverified.** The page fetches Sleeper's matchup
  endpoint from the browser. If Sleeper doesn't send permissive CORS headers this
  silently fails and the live section hides. Needs checking during real games.
- **Team abbreviations** in the H2H matrix are `name.slice(0, 3)`. A manual short
  name map would be better if teams have similar names.

## Deliberately not built

- All-time history across seasons via `previous_league_id`. Wanted, but deferred
  to the offseason — merging seasons with different rosters and scoring is the
  hard part.
- Anything requiring visitor input. See "No backend" above.
