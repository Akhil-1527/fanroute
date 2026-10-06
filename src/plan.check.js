// Run: node src/plan.check.js
import assert from 'node:assert/strict';
import { clean, dedupe, needsConfirm } from './plan.js';
import { bigRoom, spellState, usCity } from './qloo.js';

const A = (name, id = name) => ({ name, id });
assert.equal(needsConfirm('Wednesday', [A('Wednesday'), A('Wednesday 13')]), false);
assert.equal(needsConfirm('Wednesday band', [A('Band of Horses'), A('Dave Matthews Band')]), true);
assert.equal(needsConfirm('mj lenderman', [A('MJ Lenderman'), A('MJ Cole')]), false);
assert.equal(needsConfirm('The National', [A('The National'), A('National Parks')]), false);
assert.equal(needsConfirm('National', [A('The National'), A('National Parks')]), false);
assert.equal(needsConfirm('Beyonce', [A('Beyoncé'), A('Beyoncé Tribute')]), false, 'accents do not count');
assert.equal(needsConfirm('anything', [A('Something Else')]), false, 'one candidate is the answer');
assert.equal(needsConfirm('anything', []), false);

const id = 'ABCDEF12-3456-7890-ABCD-EF1234567890';
assert.equal(clean({ artistId: id }).artistId, id);
assert.equal(clean({ artistId: '<script>' }).artistId, undefined);
assert.equal(clean({ artistId: 42 }).artistId, undefined);
assert.equal(clean({}).artistId, undefined);

const act = (name, affinity, id = name) => ({ name, affinity, id });
const names = s => s.coBill.map(a => a.name);
let stops = dedupe([
  { coBill: [act('Kim Gordon', 0.96), act('Local A', 0.9)] },
  { coBill: [act('Kim Gordon', 0.96), act('Local B', 0.8)] },
  { coBill: [act('Kim Gordon', 0.96)] },
]);
assert.deepEqual(stops.map(names), [['Kim Gordon', 'Local A'], ['Local B'], []], 'a shared act lands once, on the first stop');
stops = dedupe([{ coBill: [act('X', 0.95), act('Y', 0.5)] }, { coBill: [act('X', 0.97)] }]);
assert.deepEqual(stops.map(names), [['Y'], ['X']], 'the stop where an act scores higher keeps it');
stops = dedupe([{ coBill: [act('D', 0.5), act('C', 0.6), act('B', 0.7), act('A', 0.9)] }]);
assert.deepEqual(names(stops[0]), ['C', 'B', 'A'], 'three per stop, best kept, original order');
stops = dedupe([{ coBill: [act('Nnamdi', 0.9, 'id1')] }, { coBill: [act('NNAMDI', 0.8, 'id2')] }]);
assert.deepEqual(stops.map(names), [['Nnamdi'], []], 'two entities with one name count as one act');
assert.deepEqual(dedupe([{}, { coBill: [] }]).map(names), [[], []]);

assert.equal(bigRoom('Indoor arena at the Eastern States Exposition fairgrounds hosting concerts'), true);
assert.equal(bigRoom('DIY punk and hardcore live music venue in Central Square'), false, 'Hardcore Stadium stays');
assert.equal(bigRoom('Outdoor venue with rustic vibe'), false);
assert.equal(bigRoom('Amphitheatre on the river'), true);
assert.equal(bigRoom(undefined), false);
assert.equal(bigRoom('Elegant 4,100-seat historic theater'), true);
assert.equal(bigRoom('Historic French Baroque style 3600 seat theater'), true);
assert.equal(bigRoom('200-capacity live music bar'), false);
assert.equal(bigRoom('Club with a 1,500-capacity main room'), false);

const loc = (disambiguation, lat = 1, lon = 2) => ({ name: disambiguation.split(', ')[0], disambiguation, location: { lat, lon } });
assert.deepEqual(usCity([
  loc('Portland, Dorset, England, United Kingdom'),
  loc('Portland, Multnomah, Oregon, United States of America', 45.5, -122.7),
  loc('Portland, Cumberland, Maine, United States of America'),
]), { name: 'Portland, Oregon', lat: 45.5, lon: -122.7 });
assert.equal(usCity([loc('Portland, Jamaica')]), null);
assert.equal(usCity([]), null);
assert.equal(usCity([{ name: 'Nowhere' }]), null);
assert.equal(usCity([loc('Washington, United States of America')]).name, 'Washington', 'short form keeps the plain name');
assert.equal(usCity([
  loc('Meeting House Hill, South Portland, Cumberland, Maine, United States of America'),
  loc('Portland, Cumberland, Maine, United States of America'),
], 'Portland, Maine').name, 'Portland, Maine', 'the exact city name beats a neighborhood');
const pop = (d, popularity, lat) => ({ ...loc(d, lat), popularity });
assert.equal(usCity([
  pop('Austin, Texas, United States of America', 0.965, 29.9),
  pop('Austin, Travis, Texas, United States of America', 0.999, 30.3),
], 'Austin, Texas').lat, 30.3, 'the city, not the county of the same name');
assert.equal(usCity([
  pop('Portland, Multnomah, Oregon, United States of America', 0.999),
  pop('Portland, Cumberland, Maine, United States of America', 0.992),
], 'Portland, Maine').name, 'Portland, Maine', 'the state typed beats a more popular namesake');

assert.equal(spellState('Portland, ME'), 'Portland, Maine');
assert.equal(spellState('Asheville NC'), 'Asheville, North Carolina');
assert.equal(spellState('Washington, D.C.'), 'Washington, D.C.', 'odd forms pass through');
assert.equal(spellState('Washington, dc'), 'Washington, District of Columbia');
assert.equal(spellState('Austin'), 'Austin');
assert.equal(spellState('Boise, Idaho'), 'Boise, Idaho');
assert.equal(spellState('St. Louis, MO.'), 'St. Louis, Missouri');
console.log('plan ok');
