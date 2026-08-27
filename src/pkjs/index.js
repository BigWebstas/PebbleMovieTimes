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
  inFlight: false,
  moviesCacheKey: null,  // set while a showtimes fetch is running, so sendMovies can cache it
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

var THEATERS_TTL_MS = 3 * 60 * 60 * 1000;  // 3 hours
var MOVIES_TTL_MS = 6 * 60 * 60 * 1000;    // 6 hours (and keyed by date)

function today() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function cacheGet(key, ttlMs) {
  try {
    var raw = localStorage.getItem('cache:' + key);
    if (!raw) return null;
    var o = JSON.parse(raw);
    if (!o || (Date.now() - o.t) > ttlMs) return null;
    return o.v;
  } catch (e) { return null; }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem('cache:' + key, JSON.stringify({ t: Date.now(), v: value }));
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

function httpGetJson(url, cb) {
  var req = new XMLHttpRequest();
  req.open('GET', url, true);
  req.timeout = 20000;
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
        var list = P.extractTheaters(data);
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
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Step 2: showtimes for one theater
// ---------------------------------------------------------------------------

function fetchMovies(idx, force) {
  if (state.inFlight) return;
  idx = idx | 0;
  var theater = state.theaters[idx];
  if (!theater) { sendError('Choose a theater again.'); return; }

  state.settings = loadSettings();
  if (!state.settings.serpApiKey) { sendError('Add your SerpApi key in settings.'); return; }

  var cacheKey = 'movies:' + theater.name + ':' + today();
  if (!force) {
    var hit = cacheGet(cacheKey, MOVIES_TTL_MS);
    if (hit != null) {
      console.log('showtimes: cache hit for ' + theater.name);
      sendToWatch({ MOVIES: hit });
      return;
    }
  }

  state.inFlight = true;
  state.moviesCacheKey = cacheKey;
  sendStatus('Fetching showtimes...');

  var cityShort = state.city ? state.city.split(',')[0] : '';

  // Google only renders the theater showtimes box for some query shapes, and
  // SerpApi's `location` param 400s on strings it doesn't recognise.
  var attempts = [
    { q: theater.name, location: null },
    { q: theater.name + (cityShort ? ' ' + cityShort : ''), location: state.city || null },
    { q: theater.name + ' showtimes', location: null },
  ];
  var seenKeys = {};

  function run(i) {
    if (i >= attempts.length) {
      var diag = Object.keys(seenKeys).join(',') || 'nothing';
      sendError('No showtimes for ' + theater.name + '. Google returned: ' + diag);
      return;
    }
    var a = attempts[i];
    var url = serpUrl({ engine: 'google', q: a.q, location: a.location, hl: 'en', gl: 'us' });

    httpGetJson(url, function (err, data) {
      if (err || (data && data.error)) {
        console.log('showtimes attempt ' + i + ' failed: ' + (err || data.error));
        run(i + 1);
        return;
      }
      var k = Object.keys(data).join(',');
      console.log('showtimes attempt ' + i + ' keys: ' + k);
      for (var kk in data) { if (data.hasOwnProperty(kk)) seenKeys[kk] = 1; }

      var movies = P.extractMovies(data).slice(0, MAX_MOVIES);
      if (!movies.length) { run(i + 1); return; }
      attachRatingsThenSend(movies);
    });
  }

  run(0);
}

// ---------------------------------------------------------------------------
// Step 3: IMDb ratings (OMDb, optional) then send
// ---------------------------------------------------------------------------

var ratingCache = {};

function attachRatingsThenSend(movies) {
  var key = state.settings.omdbApiKey;
  if (!key) { sendMovies(movies); return; }

  var pending = 0;
  var sent = false;
  function finish() {
    if (sent) return;
    sent = true;
    sendMovies(movies);
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
  setTimeout(finish, OMDB_TIMEOUT_MS);  // never strand the watch on "Fetching..."
}

function sendMovies(movies) {
  var payload = '';
  for (var i = 0; i < movies.length; i++) {
    var m = movies[i];
    if (i) payload += REC;
    payload += P.sanitize(m.title) + FLD + (m.rating || '') + FLD + P.sanitize(m.times);
  }
  if (state.moviesCacheKey) {
    cacheSet(state.moviesCacheKey, payload);
    state.moviesCacheKey = null;
  }
  state.inFlight = false;
  sendToWatch({ MOVIES: payload });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

Pebble.addEventListener('ready', function () {
  console.log('Movie Times: PebbleKit JS ready');
  state.settings = loadSettings();
  fetchTheaters(false);
});

Pebble.addEventListener('appmessage', function (e) {
  var d = e.payload || {};
  var force = !!d.FORCE;
  if (d.REQUEST === 'theaters') fetchTheaters(force);
  else if (d.REQUEST === 'movies') fetchMovies(d.THEATER_IDX, force);
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
