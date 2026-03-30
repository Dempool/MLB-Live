# MLB Live Tracker

Production-safe MLB tracker with MLB Stats API as the only live-game source and a server-side intelligence layer.

## What changed
- Removed all Kalshi dependencies and UI.
- Added Node/Express backend with MLB Stats API endpoints.
- Added live ticker, pitch-by-pitch feed, matchup, angle explanations, next-pitch expectation, and game buzz.
- Added generated player intelligence pipeline for active MLB players.

## Run
1. Install dependencies:
   ```bash
   npm install
   ```
2. Generate/update player intelligence cache:
   ```bash
   npm run generate:intel
   ```
3. Start server:
   ```bash
   npm start
   ```
4. Open:
   - http://localhost:8787/mlb_sharp_intel_v8_live_game_buzz.html

## Scripts
- `npm start` — start Express server on port `8787`.
- `npm run dev` — start with Node watch mode.
- `npm run generate:intel` — regenerate `generated/player-intel.json`.

## API Endpoints
- `GET /api/schedule`
- `GET /api/live-summary?gamePk=...`
- `GET /api/pitch-feed?gamePk=...`
- `GET /api/matchup?gamePk=...`
- `GET /api/savant/pitcher/:playerId`
- `GET /api/savant/batter/:playerId`
- `GET /api/game-buzz?gamePk=...`

## Limitations
- Intelligence metrics are generated from MLB Stats API stats with safe derived heuristics, not direct Baseball Savant exports.
- Next-pitch expectation is rules-based and explainable, not a trained model.

## Exact next best upgrade
Implement a scheduled ingestion job that imports official Savant CSV exports into the same `generated/` schema to replace heuristic fields with measured pitch-type and zone-level values.
