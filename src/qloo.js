// Qloo calls used by the planner. Each distinct GET is cached for a day where the Cache API exists.
import { CITIES } from './cities.js';

// QLOO_API_URL overrides the base when Qloo hands out a different server.
const BASE = 'https://hackathon.api.qloo.com';
// Ids checked against /v2/tags and live place results (2026-10-06).
const TAGS = {
  venue: 'urn:tag:setting:qloo:music_venue,urn:tag:category:place:live_music_venue,urn:tag:category:place:concert_hall,urn:tag:category:place:live_music_bar',
  spots: 'urn:tag:category:place:record_store,urn:tag:category:place:coffee_shop,urn:tag:category:place:book_store',
};

// The hackathon key allows 5 calls a second, so calls leave at least 220 ms apart and a 429 waits and retries.
// ponytail: pacing is per isolate; two busy isolates can still collide, which the retries absorb.
let nextSlot = 0;
async function paced(url, init) {
  for (let tries = 0; ; tries++) {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Date.now() + wait + 220;
    await new Promise(r => setTimeout(r, wait));
    const r = await fetch(url, init);
    if (r.status !== 429 || tries === 2) return r;
    nextSlot = Math.max(nextSlot, Date.now() + 1000);
  }
}

export async function qloo(env, path, params) {
  const url = `${(env.QLOO_API_URL || BASE).replace(/\/+$/, '')}${path}?${new URLSearchParams(params)}`;
  const cache = globalThis.caches?.default;
  const hit = await cache?.match(url);
  if (hit) return hit.json();
  const r = await paced(url, { headers: { 'X-Api-Key': env.QLOO_API_KEY } });
  if (!r.ok) throw new Error(`Qloo ${path} returned ${r.status}`);
  const text = await r.text();
  await cache?.put(url, new Response(text, { headers: { 'Cache-Control': 'max-age=86400' } }));
  return JSON.parse(text);
}

const entity = e => ({
  id: e.entity_id,
  name: e.name,
  affinity: e.query?.affinity,
  popularity: e.popularity,
  address: e.properties?.address,
  url: e.properties?.website,
  tags: (e.tags || []).slice(0, 4).map(t => t.name),
});

const insights = async (env, params) =>
  ((await qloo(env, '/v2/insights', params)).results?.entities || []).map(entity);

const near = (c, km) => ({ 'filter.location': `POINT(${c.lon} ${c.lat})`, 'filter.location.radius': km * 1000 });

export async function findArtist(env, name) {
  const j = await qloo(env, '/search', { query: name, types: 'urn:entity:artist', take: 1 });
  return j.results?.[0] && entity(j.results[0]);
}

export async function findCity(env, name) {
  const j = await qloo(env, '/search', { query: name, types: 'urn:entity:locality', take: 1 });
  const c = j.results?.[0];
  return c && { name: c.name, lat: c.location?.lat, lon: c.location?.lon };
}

// Heavy steps (a heatmap chunk, one stop's places) parse a few hundred KB of JSON each. On Cloudflare they run
// through SPLIT, a binding back to this Worker (src/index.js), so each gets its own 10 ms free-plan CPU budget.
// Without the binding (node dev.js) they run inline.
const split = (env, name, local, ...args) => (env.SPLIT ? env.SPLIT[name](...args) : local(env, ...args));

// US cities ranked by how much they over-index for the artist, weighted toward places big enough to fill a room.
// Qloo's city-boundary heatmap returns 500 and the whole-US grid is 2.3 MB, so the heatmap is asked only for small
// boxes on each touring city's center (50 per call keeps the URL under Qloo's limit). A city's affinity is the
// mean over its cells.
const D = 0.03; // box half-height in degrees, about 2 miles
const box = ([, lat, lon]) => {
  const [w, e, s, n] = [lon - D * 1.3, lon + D * 1.3, lat - D, lat + D].map(v => v.toFixed(3));
  return `((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
};
const westToEast = [...CITIES].sort((a, b) => a[2] - b[2]);
const chunks = Array.from({ length: Math.ceil(westToEast.length / 50) }, (_, i) => westToEast.slice(i * 50, i * 50 + 50));

export async function heatChunk(env, id, i) {
  const j = await qloo(env, '/v2/insights', {
    'filter.type': 'urn:heatmap', 'filter.location': `MULTIPOLYGON(${chunks[i].map(box).join(',')})`, 'signal.interests.entities': id,
  });
  const cells = j.results?.heatmap || [];
  return chunks[i].map(([name, lat, lon]) => {
    const mine = cells.filter(({ location: l }) => l && Math.abs(l.latitude - lat) <= D + 0.01 && Math.abs(l.longitude - lon) <= D * 1.3 + 0.01);
    if (!mine.length) return null;
    const mean = k => mine.reduce((sum, c) => sum + (c.query?.[k] ?? 0), 0) / mine.length;
    const affinity = mean('affinity'), popularity = mean('popularity');
    return { name, lat, lon, affinity, popularity, score: affinity * Math.sqrt(popularity) };
  }).filter(Boolean);
}

export const fanCities = async (env, id) =>
  (await Promise.all(chunks.map((_, i) => split(env, 'heat', heatChunk, id, i)))).flat();

export const venues = (env, id, c) => insights(env, {
  'filter.type': 'urn:entity:place', 'filter.tags': TAGS.venue, 'operator.filter.tags': 'union',
  'signal.interests.entities': id, ...near(c, 30), take: 3,
});

// Artists that fans of this act in this city also love: support-slot candidates who draw locally. Capped at the
// artist's own popularity, since a support act has to be someone they can actually book.
export const coBill = (env, a, c) => insights(env, {
  'filter.type': 'urn:entity:artist', 'signal.interests.entities': a.id, 'signal.location': `POINT(${c.lon} ${c.lat})`,
  'filter.exclude.entities': a.id, ...(a.popularity && { 'filter.popularity.max': a.popularity }), take: 3,
});

// Record stores, cafes and bookshops these fans already go to: where the posters and flyers go.
export const posterSpots = (env, id, c) => insights(env, {
  'filter.type': 'urn:entity:place', 'filter.tags': TAGS.spots, 'operator.filter.tags': 'union',
  'signal.interests.entities': id, ...near(c, 15), take: 3,
});

export async function stopInfo(env, a, c) {
  const [venueList, support, spots] = await Promise.all([venues(env, a.id, c), coBill(env, a, c), posterSpots(env, a.id, c)]);
  return { venues: venueList, coBill: support, spots };
}

export const stopDetails = (env, a, c) =>
  split(env, 'stop', stopInfo, { id: a.id, popularity: a.popularity }, { lat: c.lat, lon: c.lon });

export const brands = (env, id) => insights(env, { 'filter.type': 'urn:entity:brand', 'signal.interests.entities': id, take: 6 });

export const podcasts = (env, id) => insights(env, { 'filter.type': 'urn:entity:podcast', 'signal.interests.entities': id, take: 5 });

export async function audience(env, id) {
  const j = await qloo(env, '/v2/insights', { 'filter.type': 'urn:demographics', 'signal.interests.entities': id });
  return j.results?.demographics?.[0]?.query || null;
}
