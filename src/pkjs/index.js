/* Movie Times - PebbleKit JS (phone side)
 *
 *   1. get the phone's location
 *   2. find nearby movie theaters            (SerpApi, google_maps engine)
 *   3. get today's showtimes for a theater   (SerpApi, google engine showtimes box)
 *   4. attach IMDb ratings                   (OMDb, optional)
 *   5. stream results to the watch as delimited strings
 *
 * Wire format (must match src/c/app.h):
 *   record separator \x1e   field separator \x1f
 *   THEATERS : name \x1f rating \x1f distance     (repeated)
 *   MOVIES   : title \x1f rating \x1f times       (repeated)
 */

var P = require('./parse');
var configPage = require('./config_page');

var REC = '\x1e';
var FLD = '\x1f';

var MAX_THEATERS = 12;
var MAX_MOVIES = 14;
var OMDB_TIMEOUT_MS = 12000;

var state = {
  settings: null,
  city: null,       // "City, Region, Country" for the SerpApi location param
  coords: null,     // { lat, lon }
  theaters: [],      // from P.extractTheaters, sorted by distance
  inFlight: false,   // a user-driven fetch is running
  prefetching: false, // the background showtimes prefetcher is running
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
  var s = { serpApiKey: '', omdbApiKey: '', units: 'mi' };
  try {
    var raw = localStorage.getItem('settings');
    if (raw) {
      var parsed = JSON.parse(raw);
      for (var k in parsed) { if (parsed.hasOwnProperty(k)) s[k] = parsed[k]; }
    }
  } catch (e) { /* ignore */ }
  return s;
}

function saveSettings(s) {
  try { localStorage.setItem('settings', JSON.stringify(s)); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Response cache (localStorage). Keeps SerpApi calls off the 100/month quota.
// ---------------------------------------------------------------------------

// Bump when the cached payload shape or the parsing changes, to auto-invalidate.
var CACHE_PREFIX = 'cache:v4:';

var THEATERS_TTL_MS = 24 * 60 * 60 * 1000;  // 24h (also keyed by ~1km location)
var MOVIES_TTL_MS = 24 * 60 * 60 * 1000;    // 24h (also keyed by date, so expires at midnight)

function today() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function cacheGet(key, ttlMs) {
  try {
    var raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    var o = JSON.parse(raw);
    if (!o || (Date.now() - o.t) > ttlMs) return null;
    return o.v;
  } catch (e) { return null; }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch (e) { /* quota / private mode - just skip caching */ }
}

function clearCache() {
  try {
    var kill = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('cache:') === 0) kill.push(k);
    }
    for (var j = 0; j < kill.length; j++) localStorage.removeItem(kill[j]);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Messaging to the watch
// ---------------------------------------------------------------------------

function sendToWatch(dict, attempt) {
  attempt = attempt || 0;
  Pebble.sendAppMessage(dict, null, function () {
    if (attempt < 3) {
      setTimeout(function () { sendToWatch(dict, attempt + 1); }, 400);
    }
  });
}

function sendError(msg) {
  console.log('Movie Times error: ' + msg);
  state.inFlight = false;
  sendToWatch({ ERROR: String(msg).slice(0, 120) });
}

function sendStatus(msg) {
  sendToWatch({ STATUS: String(msg).slice(0, 120) });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function httpGetJson(url, cb, timeoutMs) {
  var req = new XMLHttpRequest();
  req.open('GET', url, true);
  req.timeout = timeoutMs || 20000;
  req.onload = function () {
    var body = null;
    try { body = JSON.parse(req.responseText); } catch (e) {}

    if (req.status >= 200 && req.status < 300) {
      if (body) cb(null, body);
      else cb('Unexpected response');
    } else if (body && body.error) {
      // SerpApi / OMDb return a helpful message in the body on 4xx.
      console.log('HTTP ' + req.status + ': ' + body.error);
      cb(body.error);
    } else if (req.status === 401) {
      cb('API key rejected');
    } else {
      console.log('HTTP ' + req.status + ' for ' + url.replace(/api_key=[^&]*/, 'api_key=***'));
      cb('Server error ' + req.status);
    }
  };
  req.onerror = function () { cb('Network error'); };
  req.ontimeout = function () { cb('Request timed out'); };
  req.send();
}

function serpUrl(params) {
  var qs = [];
  for (var k in params) {
    if (params.hasOwnProperty(k) && params[k] != null && params[k] !== '') {
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  }
  console.log('SerpApi request: ' + qs.join('&'));
  qs.push('api_key=' + encodeURIComponent(state.settings.serpApiKey));
  return 'https://serpapi.com/search.json?' + qs.join('&');
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

function getLocation(cb) {
  if (!navigator.geolocation) { cb('Location unavailable'); return; }
  navigator.geolocation.getCurrentPosition(
    function (pos) { cb(null, { lat: pos.coords.latitude, lon: pos.coords.longitude }); },
    function (err) {
      cb(err && err.code === 1 ? 'Location permission denied on phone' : 'Could not get location');
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 }
  );
}

function reverseGeocode(lat, lon, cb) {
  var url = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' +
    encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon) + '&localityLanguage=en';
  httpGetJson(url, function (err, data) {
    cb(err ? null : P.locationString(data));   // non-fatal
  });
}

// ---------------------------------------------------------------------------
// Step 1: nearby theaters
// ---------------------------------------------------------------------------

function buildTheaterPayload(list, coords) {
  var units = state.settings.units || 'mi';
  var payload = '';
  for (var k = 0; k < list.length; k++) {
    var t = list[k];
    var dist = (t.lat != null && t.lon != null)
      ? P.distanceStr(coords.lat, coords.lon, t.lat, t.lon, units) : '';
    if (k) payload += REC;
    payload += P.sanitize(t.name) + FLD + (t.rating || '') + FLD + dist;
  }
  return payload;
}

function fetchTheaters(force) {
  if (state.inFlight) return;
  state.settings = loadSettings();
  if (!state.settings.serpApiKey) {
    sendError('Add your SerpApi key in the app settings (phone).');
    return;
  }
  state.inFlight = true;
  sendStatus('Locating you...');

  getLocation(function (err, coords) {
    if (err) { sendError(err); return; }
    state.coords = coords;

    var cacheKey = 'theaters:' + coords.lat.toFixed(2) + ',' + coords.lon.toFixed(2);
    if (!force) {
      var hit = cacheGet(cacheKey, THEATERS_TTL_MS);
      if (hit && hit.theaters && hit.theaters.length) {
        console.log('theaters: cache hit (' + hit.theaters.length + ')');
        state.city = hit.city;
        state.theaters = hit.theaters;
        state.inFlight = false;
        sendToWatch({ THEATERS: buildTheaterPayload(hit.theaters, coords) });
        setTimeout(prefetchShowtimes, 5000);  // give the user first crack
        return;
      }
    }

    sendStatus('Finding theaters near you...');

    reverseGeocode(coords.lat, coords.lon, function (city) {
      state.city = city;

      var mapsUrl = serpUrl({
        engine: 'google_maps',
        type: 'search',
        q: 'movie theater',
        ll: '@' + coords.lat + ',' + coords.lon + ',13z',
        hl: 'en',
      });

      httpGetJson(mapsUrl, function (err2, data) {
        if ((err2 || (data && data.error)) && state.city) {
          // Fall back to the google_local engine keyed off the city name.
          console.log('google_maps failed, trying google_local');
          var localUrl = serpUrl({
            engine: 'google_local',
            q: 'movie theater',
            location: state.city,
            hl: 'en',
          });
          httpGetJson(localUrl, function (e3, d3) {
            if (e3) { sendError(e3); return; }
            if (d3.error) { sendError(d3.error); return; }
            handleTheaters(d3);
          });
          return;
        }
        if (err2) { sendError(err2); return; }
        if (data.error) { sendError(data.error); return; }
        handleTheaters(data);
      });

      function handleTheaters(data) {
        var cand = data.local_results || (data.place_results ? [data.place_results] : []);
        console.log('theater candidates: ' + cand.map(function (r) {
          return (r.title || '?') + ' [' + (r.type || r.types || '') + ']';
        }).join(' | '));

        var list = P.extractTheaters(data);
        console.log('kept as cinemas: ' + list.map(function (t) { return t.name; }).join(', '));
        for (var i = 0; i < list.length; i++) {
          list[i]._km = (list[i].lat != null && list[i].lon != null)
            ? P.haversineKm(coords.lat, coords.lon, list[i].lat, list[i].lon)
            : 99999;
        }
        list.sort(function (a, b) { return a._km - b._km; });
        list = list.slice(0, MAX_THEATERS);

        if (!list.length) { sendError('No theaters found near you.'); return; }
        state.theaters = list;
        console.log('Movie Times: ' + list.length + ' theaters near ' + (state.city || 'you'));

        cacheSet(cacheKey, { city: state.city, theaters: list });

        state.inFlight = false;
        sendToWatch({ THEATERS: buildTheaterPayload(list, coords) });
        setTimeout(prefetchShowtimes, 5000);  // give the user first crack
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Step 2: showtimes for one theater
// ---------------------------------------------------------------------------

function moviesCacheKey(theaterName) {
  return 'movies:' + theaterName + ':' + today();
}

// Sentinel cached for theaters Google has no showtimes box for, so we stop
// re-querying them all day.
var NO_SHOWTIMES = ' none';

// Fetch + parse + rate + cache one theater's showtimes. Does NOT touch
// state.inFlight or message the watch - the caller decides.
//   opts.force    - ignore the cache
//   opts.prefetch - background mode: fewer attempts, shorter timeout, and
//                   abort the moment a user-driven fetch starts
// done(err, payloadString)
function loadShowtimes(theater, opts, done) {
  opts = opts || {};
  var cacheKey = moviesCacheKey(theater.name);

  if (!opts.force) {
    var hit = cacheGet(cacheKey, MOVIES_TTL_MS);
    if (hit === NO_SHOWTIMES) {
      done('No showtimes listed for ' + theater.name + ' today.');
      return;
    }
    if (hit != null) { done(null, hit); return; }
  }

  var cityShort = state.city ? state.city.split(',')[0] : '';
  var base = theater.name + (cityShort ? ' ' + cityShort : '');

  // Google only renders the showtimes box for some query shapes. `location` is
  // omitted on purpose (SerpApi 400s on strings it can't resolve); the city
  // goes in `q` instead.
  var attempts = opts.prefetch
    ? [base + ' showtimes', base]
    : [base + ' showtimes', base, theater.name + ' showtimes'];
  var timeout = opts.prefetch ? 8000 : 15000;
  var seenKeys = {};

  function run(i) {
    if (opts.prefetch && state.inFlight) { done('aborted'); return; }  // yield to the user

    if (i >= attempts.length) {
      cacheSet(cacheKey, NO_SHOWTIMES);
      var diag = Object.keys(seenKeys).join(',') || 'nothing';
      done('No showtimes for ' + theater.name + '. Google returned: ' + diag);
      return;
    }
    if (!opts.prefetch && i > 0) sendStatus('Still checking...');  // keep the watch's watchdog fed
    var url = serpUrl({ engine: 'google', q: attempts[i], hl: 'en', gl: 'us' });

    httpGetJson(url, function (err, data) {
      if (err || (data && data.error)) {
        console.log('showtimes attempt ' + i + ' failed: ' + (err || data.error));
        run(i + 1);
        return;
      }
      for (var kk in data) { if (data.hasOwnProperty(kk)) seenKeys[kk] = 1; }

      var movies = P.extractMovies(data).slice(0, MAX_MOVIES);
      if (!movies.length) {
        console.log('showtimes attempt ' + i + ': no box (' + Object.keys(data).join(',') + ')');
        run(i + 1);
        return;
      }

      attachRatings(movies, function () {
        var payload = buildMoviePayload(movies);
        cacheSet(cacheKey, payload);
        done(null, payload);
      });
    }, timeout);
  }

  run(0);
}

function fetchMovies(idx, force) {
  idx = idx | 0;
  var theater = state.theaters[idx];
  if (!theater) { sendError('Choose a theater again.'); return; }

  state.settings = loadSettings();
  if (!state.settings.serpApiKey) { sendError('Add your SerpApi key in settings.'); return; }

  // Fast path: already cached (possibly by the prefetcher).
  if (!force) {
    var hit = cacheGet(moviesCacheKey(theater.name), MOVIES_TTL_MS);
    if (hit === NO_SHOWTIMES) {
      sendError('No showtimes listed for ' + theater.name + ' today.');
      return;
    }
    if (hit != null) {
      console.log('showtimes: cache hit for ' + theater.name);
      sendToWatch({ MOVIES: hit });
      return;
    }
  }

  if (state.inFlight) return;
  state.inFlight = true;
  sendStatus('Fetching showtimes...');

  loadShowtimes(theater, { force: force }, function (err, payload) {
    state.inFlight = false;
    if (err) { sendError(err); return; }
    sendToWatch({ MOVIES: payload });
    setTimeout(prefetchShowtimes, 3000);  // resume warming the rest of the list
  });
}

// ---------------------------------------------------------------------------
// Prefetch: after the theater list is shown, quietly warm every theater's
// showtimes into the cache. One SerpApi search per uncached theater, spaced
// out, and it bails entirely whenever the user opens a theater.
// ---------------------------------------------------------------------------

function prefetchShowtimes() {
  if (state.prefetching || state.inFlight) return;
  if (!state.settings || !state.settings.serpApiKey) return;

  var list = state.theaters.slice();
  var i = 0;
  state.prefetching = true;

  function next() {
    if (i >= list.length) {
      state.prefetching = false;
      console.log('prefetch: done');
      return;
    }
    if (state.inFlight) {                    // user is fetching - stop, resume later
      state.prefetching = false;
      console.log('prefetch: paused for user');
      return;
    }

    var t = list[i++];
    if (cacheGet(moviesCacheKey(t.name), MOVIES_TTL_MS) != null) { next(); return; }

    console.log('prefetch: ' + t.name);
    loadShowtimes(t, { prefetch: true }, function () {
      setTimeout(next, 2500);
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// Step 3: IMDb ratings (OMDb, optional)
// ---------------------------------------------------------------------------

var ratingCache = {};

function attachRatings(movies, done) {
  var key = state.settings.omdbApiKey;
  if (!key) { done(); return; }

  var pending = 0;
  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    done();
  }

  for (var i = 0; i < movies.length; i++) {
    (function (movie) {
      if (ratingCache[movie.title] !== undefined) {
        movie.rating = ratingCache[movie.title];
        return;
      }
      pending++;
      var url = 'https://www.omdbapi.com/?apikey=' + encodeURIComponent(key) +
        '&type=movie&t=' + encodeURIComponent(P.stripYear(movie.title));
      httpGetJson(url, function (err, data) {
        var r = (!err && data && data.imdbRating && data.imdbRating !== 'N/A')
          ? data.imdbRating : '';
        ratingCache[movie.title] = r;
        movie.rating = r;
        if (--pending === 0) finish();
      });
    })(movies[i]);
  }

  if (pending === 0) finish();
  setTimeout(finish, OMDB_TIMEOUT_MS);  // never strand a fetch on a slow OMDb call
}

function buildMoviePayload(movies) {
  var payload = '';
  for (var i = 0; i < movies.length; i++) {
    var m = movies[i];
    if (i) payload += REC;
    payload += P.sanitize(m.title) + FLD + (m.rating || '') + FLD + P.sanitize(m.times);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

Pebble.addEventListener('ready', function () {
  console.log('Movie Times: PebbleKit JS ready');
  state.settings = loadSettings();
  fetchTheaters(false);
});

var lastTheatersReq = 0;

Pebble.addEventListener('appmessage', function (e) {
  var d = e.payload || {};
  var force = !!d.FORCE;
  if (d.REQUEST === 'theaters') {
    var now = Date.now();
    if (now - lastTheatersReq < 3000) { console.log('ignoring rapid theaters request'); return; }
    lastTheatersReq = now;
    fetchTheaters(force);
  } else if (d.REQUEST === 'movies') {
    fetchMovies(d.THEATER_IDX, force);
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL('data:text/html;charset=utf-8,' +
    encodeURIComponent(configPage.buildConfigPage(loadSettings())));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  var incoming;
  try { incoming = JSON.parse(decodeURIComponent(e.response)); }
  catch (err) { try { incoming = JSON.parse(e.response); } catch (e2) { return; } }

  var s = loadSettings();
  if (incoming.serpApiKey !== undefined) s.serpApiKey = incoming.serpApiKey;
  if (incoming.omdbApiKey !== undefined) s.omdbApiKey = incoming.omdbApiKey;
  if (incoming.units !== undefined) s.units = incoming.units;
  saveSettings(s);
  state.settings = s;
  ratingCache = {};
  clearCache();
  fetchTheaters(true);
});
