// Run: node src/route.check.js
import assert from 'node:assert/strict';
import { miles, roadMiles, route, schedule } from './route.js';

const C = (name, lat, lon, score = 1) => ({ name, lat, lon, score });
const home = C('Denver', 39.74, -104.99, 0);
assert.ok(Math.abs(miles(home, C('Chicago', 41.88, -87.63)) - 920) < 30, 'Denver to Chicago is about 920 miles');

const cities = [
  C('Boulder', 40.01, -105.27, 5), C('Denver', 39.74, -104.99, 6), C('Colorado Springs', 38.83, -104.82, 4),
  C('Salt Lake City', 40.76, -111.89, 5), C('Albuquerque', 35.08, -106.65, 3), C('Kansas City', 39.10, -94.58, 4),
  C('Omaha', 41.26, -95.93, 2), C('Honolulu', 21.31, -157.86, 99), C('Boston', 42.36, -71.06, 50), C('Zero', 39, -100, 0),
];
const names = r => r.map(c => c.name);

const five = route(cities, home, { shows: 5, maxMiles: 350 });
assert.equal(five.length, 5);
assert.ok(!names(five).some(n => ['Honolulu', 'Boston', 'Zero'].includes(n)), 'unreachable and zero-score cities left out');
assert.ok(!(names(five).includes('Boulder') && names(five).includes('Denver')), 'one show per metro');
const loop = [home, ...five, home];
for (let i = 0; i < loop.length - 1; i++) assert.ok(roadMiles(loop[i], loop[i + 1]) <= 700, 'legs fit two driving days');

const all = route(cities, home, { shows: 50, maxMiles: 350 });
assert.equal(all.length, 6, 'stops when nothing else fits');
assert.deepEqual(route([], home), []);

const s = schedule([C('A', 39.74, -104.99), C('B', 41.88, -87.63)], home, '2026-11-01', 350);
assert.deepEqual(s.map(x => x.date), ['2026-11-01', '2026-11-05'], 'about 1,100 road miles is four days at 350 a day');
assert.equal(s[0].legMiles, 0);
const drop = names(five)[2];
const seeded = route(cities.filter(c => c.name !== drop), home, { shows: 5, maxMiles: 350, seed: five.filter(c => c.name !== drop) });
assert.equal(seeded.length, 5);
// 2-opt may still reverse a stretch, so the kept set is what must survive, not the exact order.
assert.deepEqual(names(seeded).filter(n => names(five).includes(n)).sort(), names(five).filter(n => n !== drop).sort(), 'kept stops stay');
const far = route(cities, home, { shows: 2, maxMiles: 350, seed: [cities[8]] });
assert.ok(!names(far).includes('Boston'), 'a seed the day limit no longer allows is dropped');
console.log('route ok:', names(five).join(', '));
