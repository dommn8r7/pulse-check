# Pulse Check

World-status scan, every 2 hours. A GitHub Actions job runs `scan.mjs`, which pulls a few free official feeds, asks Claude (with web search) to judge them, writes `data/status.json`, and sends an ntfy push only when the level is abnormal. `index.html` is the one-page board.

## Setup (once)
1. Create a **private** GitHub repo and push this folder to it.
2. Repo > Settings > Secrets and variables > Actions, add:
   - `ANTHROPIC_API_KEY`
   - `NTFY_TOPIC` (a long random string, e.g. `pulse-7f3k9x2m4q8w`)
   - `PAGE_URL` (the address of the published page)
3. Install the ntfy app on your phone and subscribe to that same topic name.
4. Publish the page (GitHub Pages from `main` / root, or Netlify/Cloudflare Pages).
5. Actions tab > pulse-scan > Run workflow to do the first manual run.

## Test
`node test.mjs` runs the offline acceptance tests (no network, no key).

## Knobs (env vars in the workflow)
`MAX_SEARCHES` (default 6), `DAILY_SPEND_CAP_USD` (default 8), `MODEL`, `WEB_SEARCH_TOOL_TYPE`.
Each run logs cost in `data/status.json` under `run`, and per-day spend in `data/state.json`.

## Known unverified items
- The web search tool type string (`web_search_20250305`) and the feed URLs were not tested against live services in the build environment. Check the first run's `source_health` in `status.json`.
