/* Plain-node unit tests for src/pkjs/parse.js  ->  `node test/parse.test.js` */

var assert = require('assert');
var P = require('../src/pkjs/parse');

var pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// --- distance ---------------------------------------------------------------
t('distanceStr in miles', function () {
  // ~1 deg latitude ~= 69 mi
  var d = P.distanceStr(40.0, -74.0, 40.1, -74.0, 'mi');
  assert.ok(/mi$/.test(d));
  assert.ok(parseFloat(d) > 6 && parseFloat(d) < 7, d);
});
t('distanceStr in km', function () {
  var d = P.distanceStr(40.0, -74.0, 40.1, -74.0, 'km');
  assert.ok(/km$/.test(d));
  assert.ok(parseFloat(d) > 10 && parseFloat(d) < 12, d);
});

// --- theaters --------------------------------------------------------------
t('extractTheaters from local_results', function () {
  var data = {
    local_results: [
      { title: 'AMC Empire 25', rating: 4.1, address: '234 W 42nd St',
        gps_coordinates: { latitude: 40.756, longitude: -73.989 } },
      { title: 'Regal Union Square', address: '850 Broadway' },
      { position: 3 } // junk, no title -> skipped
    ]
  };
  var list = P.extractTheaters(data);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, 'AMC Empire 25');
  assert.strictEqual(list[0].rating, '4.1');
  assert.strictEqual(list[1].lat, null);
});
t('extractTheaters from single place_results', function () {
  var list = P.extractTheaters({ place_results: { title: 'The Paris Theater', rating: 4.7 } });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].rating, '4.7');
});

// --- showing flattening ---------------------------------------------------
t('flattenShowing with time arrays and formats', function () {
  var s = P.flattenShowing([
    { type: 'Standard', time: ['1:30pm', '4:45pm'] },
    { type: 'IMAX', time: ['8:00pm'] }
  ]);
  assert.strictEqual(s, '1:30pm, 4:45pm, IMAX 8:00pm');
});
t('flattenShowing with comma string', function () {
  var s = P.flattenShowing([{ type: 'Standard', time: '2:00pm, 5:15pm' }]);
  assert.strictEqual(s, '2:00pm, 5:15pm');
});
t('flattenShowing empty', function () {
  assert.strictEqual(P.flattenShowing(null), '');
  assert.strictEqual(P.flattenShowing([]), '');
});

// --- movies extraction --------------------------------------------------
var theaterSearchResponse = {
  showtimes: [
    {
      day: 'Today',
      movies: [
        { name: 'Dune: Part Two', link: 'x',
          showing: [{ type: 'Standard', time: ['12:00pm', '3:30pm'] },
                    { type: 'IMAX', time: ['7:00pm'] }] },
        { name: 'Kung Fu Panda 4',
          showing: [{ type: 'Standard', time: ['11:15am', '1:45pm'] }] },
        { name: 'No Showtimes Movie', showing: [] }
      ]
    },
    { day: 'Tomorrow', movies: [{ name: 'X', showing: [{ time: ['1:00pm'] }] }] }
  ]
};

t('extractMovies picks Today and drops empty showings', function () {
  var m = P.extractMovies(theaterSearchResponse);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].title, 'Dune: Part Two');
  assert.strictEqual(m[0].times, '12:00pm, 3:30pm, IMAX 7:00pm');
  assert.strictEqual(m[1].title, 'Kung Fu Panda 4');
});
t('extractMovies falls back to first day when no "Today"', function () {
  var m = P.extractMovies({ showtimes: [{ day: 'Fri', movies: [
    { name: 'A', showing: [{ time: ['5:00pm'] }] }] }] });
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].times, '5:00pm');
});
t('extractMovies handles missing showtimes block', function () {
  assert.deepStrictEqual(P.extractMovies({}), []);
  assert.deepStrictEqual(P.extractMovies({ showtimes: [] }), []);
});

// --- misc ---------------------------------------------------------------
t('sanitize strips delimiters', function () {
  assert.strictEqual(P.sanitize('AMC\x1f Empire\x1e 25\n'), 'AMC Empire 25');
});
t('stripYear', function () {
  assert.strictEqual(P.stripYear('Wicked (2024)'), 'Wicked');
  assert.strictEqual(P.stripYear('2001: A Space Odyssey'), '2001: A Space Odyssey');
});
t('locationString from BigDataCloud shape', function () {
  var s = P.locationString({ city: 'Austin', principalSubdivision: 'Texas', countryName: 'United States' });
  assert.strictEqual(s, 'Austin, Texas, United States');
  assert.strictEqual(P.locationString({}), null);
});

console.log('\n' + pass + ' passed');
