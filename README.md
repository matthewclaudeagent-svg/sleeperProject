# Finance League — Dashboard

A static dashboard for a 12-team full-PPR Sleeper league. A GitHub Actions cron
rebuilds `data.json` every hour; GitHub Pages serves the page. No server, no
database, no dependencies, no cost.

Sleeper league ID: `1390786042679812096`

---

## Setup

**1. Create a public repo and push these files.**

```
index.html
build.js
package.json
.github/workflows/refresh.yml
```

The repo needs to be public for GitHub Pages to work on a free account. Nothing
secret lives in it — the Sleeper and FantasyCalc APIs are both keyless.

**2. Add the recap API key.**

Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |

Repository secrets are encrypted and are never written into `data.json` or
exposed on the page. If you skip this, everything still builds — the recap
section just stays empty.

**3. Generate the first data file.**

Actions tab → "Refresh league data" → Run workflow. This takes about a minute,
mostly downloading the Sleeper player list. It commits `data.json` and
`players.json` back to the repo.

**4. Turn on Pages.**

Settings → Pages → Source: Deploy from a branch → `main` / `root`.

Your site lands at `https://<username>.github.io/<repo>`. To use a custom
domain, add a `CNAME` file containing the domain and point a CNAME record at
`<username>.github.io`.

---

## Running it locally

Node 20 or newer. No `npm install` needed — there are zero dependencies.

```bash
node build.js          # writes data.json and players.json
npx serve .             # or: python3 -m http.server
```

Open the local URL. The page fetches `data.json` over HTTP, so opening
`index.html` directly with `file://` will not work.

---

## How it works

```
Sleeper API ─┐
FantasyCalc ─┼─► build.js ─► data.json ─► index.html (fetch + render)
Anthropic  ─┘      ▲
                   │
            hourly cron (GitHub Actions)
```

`build.js` does all the computation. `index.html` does no math — it reads a flat
`data.json` and renders it. Anything that needs calculating belongs in the build
script, not the page.

The one exception is live scoring: during games the page fetches Sleeper's
matchup endpoint directly every 60 seconds, because an hourly cron is useless on
a Sunday. That section hides itself when no games are in progress.

### Files

| File | Role |
| --- | --- |
| `build.js` | Fetches, computes, writes `data.json` |
| `index.html` | Markup, styles, and render logic in one file |
| `data.json` | Generated. Committed so Pages can serve it |
| `players.json` | Generated. Slimmed Sleeper player map, refreshed daily |
| `.github/workflows/refresh.yml` | Hourly cron |

### What gets computed

- Standings, points for and against
- **All-play record** — your record if you played every team every week
- **Playoff odds** — 10,000 Monte Carlo simulations of the remaining schedule,
  drawing each team's weekly score from its own mean and standard deviation
- **Lineup efficiency** — points started as a share of your best possible lineup
- **Bench points** — what the optimal lineup would have scored, minus what you did
- **Weekly awards** — most and fewest points, highest-scoring loss, lowest-scoring
  win, biggest blowout, closest game
- **Wall of shame** — season-long tallies of each award
- **Head-to-head matrix** — every manager against every other
- **Waiver ROI** — points each pickup scored after being added
- **Trade suggestions** — pairs where both sides fill a positional gap at close
  to equal FantasyCalc value
- **AI weekly recap** — written once per completed week, then cached

---

## League settings this code depends on

These are hardcoded as constants at the top of `build.js`. If the league
settings change, update them there.

| Setting | Value |
| --- | --- |
| Teams | 12 |
| Scoring | Full PPR, 4-pt passing TD, −2 fumble |
| Lineup | QB, RB, RB, WR, WR, TE, FLEX, K, DEF + 5 bench, 1 IR |
| Regular season | Weeks 1–14 |
| Playoffs | Week 15, top 6 |
| Trade deadline | Week 11 |
| Waivers | Rolling priority, not FAAB |
| Keepers | None (redraft) |

---

## Known limits

- **FantasyCalc does not price kickers or defenses.** They come back as zero
  value, so trade suggestions never involve them. This is labeled on the page.
- **Live score polling depends on Sleeper allowing cross-origin requests.** If
  it doesn't, the live section silently disappears and everything else works.
  Verify during an actual Sunday slate.
- **Scheduled workflows get disabled after 60 days of repo inactivity.** Bot
  commits may not reset that timer. During the season you'll be pushing anyway.
- **Team abbreviations in the H2H matrix are the first three characters** of the
  team name. Teams with similar names will look alike; full names show on hover.
- **The optimal-lineup solver is greedy**, which is correct for this roster
  shape but would need rewriting if the league ever adds a second FLEX or a
  superflex.

---

## Ideas not yet built

Saved for the offseason: Sleeper's league object has a `previous_league_id`
field (`1263303758238986240` for last season), which lets you walk backward
through every prior year of the same league and build all-time records and
historical head-to-head. The hard part is merging seasons whose rosters and
scoring settings differ.
