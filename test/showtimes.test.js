/* Plain-node tests for loadShowtimes cache behaviour in src/pkjs/index.js.
 *   node test/showtimes.test.js
 *
 * Stubs the PebbleKit JS globals (localStorage, XMLHttpRequest, Pebble) so the
 * phone-side module loads under bare node, then drives loadShowtimes with a
 * programmable fake network. */

// --- global stubs (must exist before index.js is required) ------------------

var store = {};
global.localStorage = {
  getItem: function (k) {
    return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
  },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; },
  key: function (i) { return Object.keys(store)[i]; },
  get length() { return Object.keys(store).length; },
};

global.Pebble = {
  addEventListener: function () {},
  sendAppMessage: function () {},
  openURL: function () {},
};

global.navigator = { geolocation: null };

// router(query, url) returns one of:
//   { status, body }        - an HTTP reply (body object is JSON-stringified)
//   { timeout: true }       - fires req.ontimeout
//   { networkError: true }  - fires req.onerror
var router = function () { return { timeout: true }; };

global.XMLHttpRequest = function () {
  this.open = function (m, u) { this._url = u; };
  this.send = function () {
    var self = this;
    setTimeout(function () {
      var m = /[?&]q=([^&]*)/.exec(self._url || '');
      var q = m ? decodeURIComponent(m[1]) : '';
      var r = router(q, self._url) || { timeout: true };
      if (r.networkError) { if (self.onerror) self.onerror(); return; }
      if (r.timeout) { if (self.ontimeout) self.ontimeout(); return; }
      self.status = r.status;
      self.responseText = typeof r.body === 'string'
        ? r.body : JSON.stringify(r.body || {});
      if (self.onload) self.onload();
    }, 0);
  };
};

var I = require('../src/pkjs/index');

// --- fixtures -------------------------------------------------------------

var BOX = { showtimes: [{ day: 'Today', movies: [
  { name: 'Dune', showing: [{ type: 'Standard', time: ['1:00pm', '4:00pm'] }] },
] }] };
var NOBOX = { search_metadata: { status: 'Success' }, organic_results: [] };

var theater = { name: 'Galaxy Cinema' };

// --- sequential async runner --------------------------------------------

var pass = 0;
var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

function run(i) {
  if (i >= tests.length) {
    console.log('\n' + pass + ' passed');
    return;
  }
  var test = tests[i];
  store = {};
  I._state.settings = { serpApiKey: 'k', omdbApiKey: '', units: 'mi', cacheHours: 24 };
  I._state.city = 'Springfield, IL, United States';
  I._state.inFlight = false;

  var done = false;
  function finish(errMsg) {
    if (done) return;
    done = true;
    if (errMsg) {
      console.error('  FAIL ' + test.name + '\n       ' + errMsg);
      process.exitCode = 1;
    } else {
      pass++;
      console.log('  ok  ' + test.name);
    }
    setImmediate(function () { run(i + 1); });
  }

  try {
    test.fn(function () { finish(); }, function (m) { finish(m || 'failed'); });
  } catch (e) {
    finish(e.message);
  }
  setTimeout(function () { finish('timed out'); }, 2000);
}

// --- tests -------------------------------------------------------------

t('a timeout on every attempt does not cache NO_SHOWTIMES', function (ok, fail) {
  router = function () { return { timeout: true }; };
  I.loadShowtimes(theater, {}, function (err, payload) {
    if (!err) return fail('expected an error, got ' + payload);
    var cached = I._cacheGet(I.moviesCacheKey(theater.name), 9e9);
    if (cached != null) return fail('cache was poisoned: ' + JSON.stringify(cached));
    ok();
  });
});

t('a SerpApi error on every attempt does not cache NO_SHOWTIMES', function (ok, fail) {
  router = function () { return { status: 429, body: { error: 'quota exceeded' } }; };
  I.loadShowtimes(theater, { prefetch: true }, function (err) {
    if (!err) return fail('expected an error');
    var cached = I._cacheGet(I.moviesCacheKey(theater.name), 9e9);
    if (cached != null) return fail('cache was poisoned: ' + JSON.stringify(cached));
    ok();
  });
});

t('a clean reply with no showtimes box caches NO_SHOWTIMES', function (ok, fail) {
  router = function () { return { status: 200, body: NOBOX }; };
  I.loadShowtimes(theater, {}, function (err) {
    if (!err) return fail('expected an error');
    var cached = I._cacheGet(I.moviesCacheKey(theater.name), 9e9);
    if (cached !== I.NO_SHOWTIMES) {
      return fail('expected NO_SHOWTIMES, got ' + JSON.stringify(cached));
    }
    ok();
  });
});

t('prefetch tries the bare-name query shape (3rd attempt)', function (ok, fail) {
  router = function (q) {
    return q === 'Galaxy Cinema showtimes'
      ? { status: 200, body: BOX }
      : { status: 200, body: NOBOX };
  };
  I.loadShowtimes(theater, { prefetch: true }, function (err, payload) {
    if (err) return fail('expected success, got ' + err);
    if (!/Dune/.test(payload)) return fail('payload missing movie: ' + payload);
    ok();
  });
});

run(0);
