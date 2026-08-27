# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A PebbleOS watchapp. Native C on the watch, PebbleKit JS on the phone. The phone
side does all networking (GPS → nearby cinemas → today's showtimes → IMDb
ratings) and streams results to the watch as delimited strings.

## Toolchain

`pebble` is not on `PATH` by default — it lives at `~/.local/bin/pebble`
(installed via `uv tool install --python 3.13 pebble-tool`; pebble-tool does not
support Python 3.14). SDK 4.33.1 is installed. Prefix commands with
`export PATH="$HOME/.local/bin:$PATH"` or call the binary directly.

```sh
pebble build                       # -> build/PebbleMovieTimes.pbw (all target platforms)
pebble clean                       # needed after editing messageKeys in package.json
pebble install --emulator basalt   # run in the qemu emulator (auto-launches it)
pebble install --phone <IP>        # sideload to a real watch on the dev connection
pebble logs --emulator basalt      # live logs (C APP_LOG + pkjs console.log)
pebble kill                        # stop the emulator
node test/parse.test.js            # JS unit tests (plain node, no deps)
```

There is no lint step. `pebble build` compiles the C for every platform in
`package.json` `targetPlatforms` and bundles `src/pkjs/*.js` via the multi-JS
merge (entry point `src/pkjs/index.js`).

### Testing without a live API key

The emulator has no SerpApi key, so the app only reaches the error/splash state
on its own. Inject data straight into the running watchapp with numeric message
keys (see `build/src/message_keys.auto.c` for the IDs — `THEATERS`=10002,
`MOVIES`=10003) using the app's wire format (record sep `\x1e`, field sep
`\x1f`):

```sh
PAYLOAD=$'AMC Empire 25\x1f4.5\x1f0.3 mi\x1eRegal Union Square\x1f4.1\x1f0.6 mi'
pebble send-app-message --emulator basalt --string 10002="$PAYLOAD"
```

`pebble emu-button [click|push|release] [back|up|select|down] -d <ms>` drives the
UI (`-d 800 click select` = long-press). `pebble screenshot --emulator basalt out.png`.

### Regenerating the app icon / logo

`~/.local/share/uv/tools/pebble-tool/bin/python tools/make_images.py` (needs the
pebble-tool Python, which bundles Pillow). Writes `resources/images/menu_icon.png`
and `logo.png`.

## Architecture

### The AppMessage contract (must stay in sync)

`package.json` `messageKeys` ⇔ `src/c/app.h` (`REC_SEP`/`FLD_SEP`, struct sizes)
⇔ `src/pkjs/index.js` (`REC`/`FLD`, payload builders). Editing `messageKeys`
requires `pebble clean` before the next build regenerates `message_keys.auto.h`.

Flow:
1. Watch sends `{REQUEST: "theaters"|"movies", THEATER_IDX, FORCE}`.
2. Phone replies with `STATUS` progress pings, then one of:
   - `THEATERS`: `name \x1f rating \x1f distance` records joined by `\x1e`
   - `MOVIES`: `title \x1f imdbRating \x1f "time, time, IMAX time…"` records
   - `ERROR`: a string shown on the watch.
   A whole screen's list arrives as **one** string message (watch inbox is 4 KB;
   `index.js` caps at 12 theaters / 14 movies / ~150 chars of times).

### Watch side (`src/c/`)

- `main.c` — global data store (`g_theaters`, `g_movies`, `g_state`), AppMessage
  in/out, `parse_theaters`/`parse_movies` (split the delimited strings into the
  global structs), and a `~50s` watchdog `AppTimer` that flips a stuck load to an
  error.
- `app.h` — the shared model: `Theater`/`Movie` structs, the `AppState` enum
  (`STATE_LOADING_THEATERS` … `STATE_ERROR`), and every cross-file declaration.
- `theaters_window.c` / `movies_window.c` — `MenuLayer` screens. `theaters` also
  owns the logo splash layer (shown when there's no list yet), shake-to-refresh
  (`accel_tap_service`, 5s debounce), and favorite pin/unpin on long-press.
- `showtimes_window.c` — `ScrollLayer` detail view; times rendered one per line.
  Created/destroyed per push (the two menu windows are long-lived singletons).
- `favorites.c` — pinned theaters persisted as one `\x1e`-delimited name list in
  `persist` key 1; `favorites_apply()` flags + stable-sorts pinned rows to the
  top after every `parse_theaters`.
- `ui.c` — `ui_draw_info_cell`, the wrapped-text renderer for loading/error rows.

`is_list_ready()` in each menu window deliberately keys off "do we have data"
rather than a single global state, so backing out of a sub-screen never lands on
a blank loader.

### Phone side (`src/pkjs/`)

- `index.js` — orchestration and all side effects (network, `localStorage`,
  `sendAppMessage`). Key pieces:
  - `fetchTheaters(force)` → GPS → `reverseGeocode` (BigDataCloud, no key) →
    SerpApi `google_maps` (falls back to `google_local`) → `P.extractTheaters`.
  - `loadShowtimes(theater, opts, done)` — the reusable "get one theater's
    showtimes" unit: tries a few SerpApi `google` query shapes (NO `location`
    param — it 400s on unrecognised strings), `P.extractMovies`, then OMDb
    ratings, then caches. No watch/`state.inFlight` side effects — callers
    decide.
  - `fetchMovies` uses `loadShowtimes` for a tapped theater; `prefetchShowtimes`
    uses it to warm every theater in the list (spaced out, aborts hard the
    moment `state.inFlight` is set by a user tap).
  - Response cache in `localStorage` keyed `CACHE_PREFIX + …`; bump
    `CACHE_PREFIX` (`cache:vN:`) when payload/parse shape changes to invalidate.
    Theaters keyed by ~1km-rounded location; showtimes keyed by theater+date.
    TTL is user-settable via `cacheTtlMs()` (6/24/48h). A `NO_SHOWTIMES`
    sentinel is cached for theaters Google has no data for.
  - `serpUrl()` bumps a local search counter; `fetchSerpAccount()` reads the
    real quota from SerpApi's free `/account` endpoint (shown in settings).
- `parse.js` — **pure** functions only (no Pebble/network APIs) so
  `test/parse.test.js` can run them under plain node. `looksLikeCinema()` is the
  filter that keeps only real movie theaters out of `google_maps` results — it
  trusts Google's exact `type == "Movie theater"` or a known chain name and
  rejects everything else (amphitheaters, playhouses, A/V service businesses).
  When touching it, add a case to the test with a realistic `local_results` item.
- `config_page.js` — the settings UI as a self-contained HTML string served via a
  `data:` URI (no hosting, no Clay). Submits back through
  `pebblejs://close#<json>`; `index.js`'s `webviewclosed` handler saves it and
  only clears the cache / refetches when a key or units actually changed.

## Data sources & limits

SerpApi (theaters + showtimes, free tier 100 searches/month — prefetch spends
~12 per refresh), BigDataCloud (reverse geocode, keyless), OMDb (optional IMDb
ratings). Google only renders a showtimes box in regions it has cinema data for;
some legit second-run theaters return nothing and there's no fix for that.
