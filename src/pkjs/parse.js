/* Pure helpers for turning SerpApi / geo responses into watch-ready data.
 * No Pebble or network APIs in here so it can be unit tested with plain node
 * (see test/parse.test.js). */

var TIMES_MAX_CHARS = 150;

function sanitize(str) {
  // Strip our field/record delimiters and other control chars from free text.
  return String(str == null ? '' : str).replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripYear(title) {
  return String(title).replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceStr(lat1, lon1, lat2, lon2, units) {
  var km = haversineKm(lat1, lon1, lat2, lon2);
  if (units === 'km') return km.toFixed(km < 10 ? 1 : 0) + ' km';
  var mi = km * 0.621371;
  return mi.toFixed(mi < 10 ? 1 : 0) + ' mi';
}

var CINEMA_RE = /cinema|cineplex|movie theat|multiplex|megaplex|drive-?in|imax/i;
var CHAIN_RE = /\b(amc|regal|cinemark|cinepolis|cin[eé]polis|megaplex|marcus|harkins|showcase|odeon|vue|picturehouse|alamo drafthouse|landmark|ipic|studio movie grill|emagine|maya cinemas|bow tie|reading cinemas|cmx|b&b theatres|malco|santikos)\b/i;
var NOT_CINEMA_RE = /amphitheat|performing arts|concert hall|live music|playhouse|opera|symphony|ballet|stadium|\barena\b|fairground|convention center|community theat|dinner theat/i;

// Does a place look like an actual movie theater (vs. an amphitheater, live
// venue, playhouse, etc. that Google Maps also returns for "movie theater")?
function looksLikeCinema(name, type) {
  name = String(name || '');
  type = String(type || '');
  if (NOT_CINEMA_RE.test(name) || NOT_CINEMA_RE.test(type)) return false;
  if (/movie theat|cinema/i.test(type)) return true;
  if (CINEMA_RE.test(name) || CHAIN_RE.test(name)) return true;
  if (type) return /theat/i.test(type);  // trust an explicit "…theater" type
  return true;                            // no type info: don't over-filter
}

// data.local_results / data.place_results  ->  [{ name, lat, lon, rating, address, type }]
function extractTheaters(data) {
  var raw = [];
  if (data && data.local_results && data.local_results.length) raw = data.local_results;
  else if (data && data.place_results) raw = [data.place_results];

  var list = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i];
    if (!r || !r.title) continue;
    var type = r.type || (r.types && r.types.join(' ')) || '';
    if (!looksLikeCinema(r.title, type)) continue;
    var g = r.gps_coordinates || {};
    list.push({
      name: r.title,
      lat: (g.latitude != null) ? g.latitude : null,
      lon: (g.longitude != null) ? g.longitude : null,
      rating: (r.rating != null) ? String(r.rating) : '',
      address: r.address || '',
      type: type,
    });
  }
  return list;
}

// One theater's "showing" array -> "6:00pm, 8:30pm, IMAX 10:00pm"
function flattenShowing(showing) {
  if (!showing || !showing.length) return '';
  var parts = [];
  for (var i = 0; i < showing.length; i++) {
    var s = showing[i] || {};
    var label = (s.type && !/standard/i.test(s.type)) ? (s.type + ' ') : '';
    var t = (s.time != null) ? s.time : s.times;
    if (Object.prototype.toString.call(t) === '[object Array]') {
      for (var j = 0; j < t.length; j++) parts.push(label + String(t[j]).trim());
    } else if (typeof t === 'string') {
      var split = t.split(/\s*,\s*/);
      for (var k = 0; k < split.length; k++) parts.push(label + split[k].trim());
    }
  }
  return parts.join(', ').slice(0, TIMES_MAX_CHARS).replace(/,\s*[^,]*$/, function (m) {
    // avoid ending on a half-truncated time
    return /\d/.test(m) ? m : '';
  });
}

// data.showtimes -> [{ title, times }] for today (or the first day available)
function extractMovies(data) {
  var out = [];
  var blocks = (data && data.showtimes) ||
    (data && data.answer_box && data.answer_box.showtimes) ||
    (data && data.knowledge_graph && data.knowledge_graph.showtimes) || null;
  if (!blocks || !blocks.length) return out;

  var block = null;
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].movies && blocks[i].movies.length) {
      if (!block) block = blocks[i];
      if (/today/i.test(blocks[i].day || '')) { block = blocks[i]; break; }
    }
  }
  if (!block) return out;

  for (var m = 0; m < block.movies.length; m++) {
    var mv = block.movies[m] || {};
    if (!mv.name) continue;
    var times = flattenShowing(mv.showing);
    if (!times) continue;
    out.push({ title: mv.name, times: times });
  }
  return out;
}

// data (BigDataCloud reverse geocode) -> "City, Region, Country" or null
function locationString(data) {
  if (!data) return null;
  var parts = [];
  var city = data.city || data.locality;
  if (!city && data.localityInfo && data.localityInfo.administrative) {
    var admin = data.localityInfo.administrative;
    if (admin[3] && admin[3].name) city = admin[3].name;
  }
  if (city) parts.push(city);
  if (data.principalSubdivision) parts.push(data.principalSubdivision);
  var country = data.countryName;
  if (country === 'United States of America' || country === 'USA') country = 'United States';
  if (country) parts.push(country);
  return parts.length ? parts.join(', ') : null;
}

module.exports = {
  sanitize: sanitize,
  stripYear: stripYear,
  haversineKm: haversineKm,
  distanceStr: distanceStr,
  extractTheaters: extractTheaters,
  flattenShowing: flattenShowing,
  extractMovies: extractMovies,
  locationString: locationString,
};
