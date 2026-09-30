// Qloo calls used by the planner. Each distinct GET is cached for a day where the Cache API exists.
const BASE = 'https://hackathon.api.qloo.com';
// Contiguous US as a WKT box, longitude first.
const US = 'POLYGON((-124.8 49.4,-66.9 49.4,-66.9 24.4,-124.8 24.4,-124.8 49.4))';
// TODO before launch: confirm these ids with /v2/tags once the key works.
const TAGS = {
  venue: 'urn:tag:category:place:music_venue',
  spots: 'urn:tag:category:place:record_store,urn:tag:category:place:coffee_shop,urn:tag:category:place:bookstore',
};

export async function qloo(env, path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const cache = globalThis.caches?.default;
  const hit = await cache?.match(url);
  if (hit) return hit.json();
  const r = await fetch(url, { headers: { 'X-Api-Key': env.QLOO_API_KEY } });
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

// US cities ranked by how much they over-index for the artist, weighted toward places big enough to fill a room.
export async function fanCities(env, id) {
  const j = await qloo(env, '/v2/insights', {
    'filter.type': 'urn:heatmap',
    'filter.location': US,
    'signal.interests.entities': id,
    'output.heatmap.boundary': 'city',
    take: 50,
  });
  return (j.results?.heatmap || []).map(h => ({
    name: h.location?.name,
    lat: h.location?.latitude,
    lon: h.location?.longitude,
    affinity: h.query?.affinity,
    popularity: h.query?.popularity,
    score: (h.query?.affinity ?? 0) * Math.sqrt(h.query?.popularity ?? 1),
  }));
}

export const venues = (env, id, c) => insights(env, {
  'filter.type': 'urn:entity:place', 'filter.tags': TAGS.venue, 'signal.interests.entities': id, ...near(c, 30), take: 3,
});

// Artists that fans of this act in this city also love: support-slot candidates who draw locally.
export const coBill = (env, id, c) => insights(env, {
  'filter.type': 'urn:entity:artist', 'signal.interests.entities': id, 'signal.location': `POINT(${c.lon} ${c.lat})`,
  'filter.exclude.entities': id, take: 3,
});

// Record stores, cafes and bookshops these fans already go to: where the posters and flyers go.
export const posterSpots = (env, id, c) => insights(env, {
  'filter.type': 'urn:entity:place', 'filter.tags': TAGS.spots, 'operator.filter.tags': 'union',
  'signal.interests.entities': id, ...near(c, 15), take: 3,
});

export const brands = (env, id) => insights(env, { 'filter.type': 'urn:entity:brand', 'signal.interests.entities': id, take: 6 });

export const podcasts = (env, id) => insights(env, { 'filter.type': 'urn:entity:podcast', 'signal.interests.entities': id, take: 5 });

export async function audience(env, id) {
  const j = await qloo(env, '/v2/insights', { 'filter.type': 'urn:demographics', 'signal.interests.entities': id });
  return j.results?.demographics?.[0]?.query || null;
}
