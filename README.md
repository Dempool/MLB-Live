# MLB Live Tracker

Production-oriented MLB tracker using **MLB Stats API as the single live source of truth**.

## What this build includes

- Node/Express backend on port **8787**.
- Live endpoints for schedule, pregame, summary, pitch feed, matchup, and game buzz.
- Server-side Savant-style intelligence lookup via local generated cache.
- Rules-based next-pitch expectation model (no fake ML).
- Frontend sections:
  - Live Ticker
  - Current Matchup
  - Pitch By Pitch
  - Pitcher Card
  - Batter Card
  - Pitcher vs Batter
  - Simple Angles
  - Next Pitch Expectation
  - Game Buzz
- Knowledge level dropdown (New / Intermediate / Experienced) persisted in `localStorage`.
- Sidebar game sorting: live first, preview second, final last.

## Run

```bash
node scripts/generate-player-intel.js
node server.js
```

Open: `http://localhost:8787`

## Scripts

- `node server.js` - run server
- `node scripts/generate-player-intel.js` - regenerate local player intelligence dataset
- `npm start` / `npm run dev` / `npm run generate:intel` remain as aliases (no install required)

## API

- `GET /api/schedule`
- `GET /api/pregame?gamePk=...`
- `GET /api/live-summary?gamePk=...`
- `GET /api/pitch-feed?gamePk=...`
- `GET /api/matchup?gamePk=...`
- `GET /api/savant/pitcher/:playerId`
- `GET /api/savant/batter/:playerId`
- `GET /api/game-buzz?gamePk=...`

## Data notes

- Live game state always comes from MLB Stats API endpoints.
- Player intelligence is generated into `generated/player_intel.json` from current MLB active rosters and deterministic stat-style derived metrics.
- The generator structure is designed so a real Savant export can replace the derived logic later with minimal API changes.

## Limitations

- Intelligence metrics are generated approximations, not direct Baseball Savant export values.
- Pitcher vs batter history from true historical PA logs is not yet ingested.

## Exact next best upgrade

Build a nightly ingestion job that consumes official Statcast/Savant exports and replaces deterministic derived metrics in `generated/player_intel.json` with real measured values while preserving the current API response contract.
