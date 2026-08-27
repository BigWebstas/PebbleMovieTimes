# Movie Times

A Pebble watchapp that uses your phone's location to list movie theaters near
you, then shows each theater's movies, today's showtimes, and IMDb ratings.

```
Theaters near you        ->   AMC Empire 25            ->   Dune: Part Two
★ AMC Empire 25               Dune: Part Two               IMDb 8.5
  4.1★ • 0.3 mi                IMDb 8.5 • 12:00pm...        12:00pm
  Regal Union Square          Kung Fu Panda 4              3:30pm
  4.0★ • 0.6 mi                IMDb 6.4 • 11:15am...        IMAX 7:00pm
```

**Select** opens a theater; **long-press Select** pins it as a favorite (★) so
it stays at the top of the list. Favorites persist on the watch.

## How it works

| Piece | Role |
|-------|------|
| `src/c/*` | The watchapp: three menu screens (theaters → movies → showtimes). |
| `src/c/favorites.c` | Pin/unpin theaters; persisted with `persist_*`. |
| `src/pkjs/index.js` | Runs on the phone. Gets GPS, calls the APIs, streams results to the watch. |
| `src/pkjs/parse.js` | Pure response-parsing helpers (unit tested). |
| `src/pkjs/config_page.js` | The settings screen (self-contained, no hosting needed). |

Data sources:

- **[SerpApi](https://serpapi.com)** – nearby theaters (`google_maps` engine) and
  Google's showtimes box (`google` engine). Free tier is 100 searches/month;
  opening the app costs 1 search, opening a theater costs 1 more.
- **[BigDataCloud](https://www.bigdatacloud.com)** – free reverse geocoding
  (lat/long → city) for the SerpApi `location` parameter. No key.
- **[OMDb](https://www.omdbapi.com)** – IMDb ratings. Optional; ratings are just
  omitted without a key.

## Setup

1. Install the Pebble SDK (via [pebble-tool](https://developer.rebble.io/guides/tools-and-resources/pebble-tool/)):

   ```sh
   uv tool install --python 3.13 pebble-tool
   pebble sdk install latest
   ```

2. Build:

   ```sh
   pebble build
   ```

3. Run in the emulator or install to a watch:

   ```sh
   pebble install --emulator basalt
   # or, with the phone app + developer connection:
   pebble install --phone <PHONE_IP>
   ```

4. Open the app's **Settings** (long-press it in the Pebble phone app, or the
   gear in the appstore list) and paste your SerpApi key. Optionally add an
   OMDb key and pick miles/kilometers.

## Tests

```sh
node test/parse.test.js
```

Covers distance formatting, theater extraction, showtime flattening (time
arrays, comma strings, IMAX/Dolby labels), the "today vs first day" pick, and
reverse-geocode string building.

## Notes / limitations

- Google only exposes a showtimes box for locations it has cinema data for
  (mainly US/CA and major metros). Elsewhere you'll get "No showtimes listed".
- The showtimes preview line in the movie list is truncated; the detail screen
  shows every time.
- Watch AppMessage inbox is 4 KB, so the movie list is capped at 14 titles and
  each showtime string at ~150 chars.
- SerpApi's free tier is small. If you open the app a lot, consider caching or
  upgrading.
