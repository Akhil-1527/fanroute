// Qloo calls used by the planner. Each distinct GET is cached for a day where the Cache API exists.
import { CITIES } from './cities.js';

// QLOO_API_URL overrides the base when Qloo hands out a different server.
const BASE = 'https://hackathon.api.qloo.com';
// Ids checked against /v2/tags and live place results (2026-10-06).
const TAGS = {
  venue: 'urn:tag:setting:qloo:music_venue,urn:tag:category:place:live_music_venue,urn:tag:category:place:concert_hall,urn:tag:category:place:live_music_bar',
  spots: 'urn:tag:category:place:record_store,urn:tag:category:place:coffee_shop,urn:tag:category:place:book_store',
  // Places Qloo also tags as live music that an independent act can't or wouldn't book: arenas, fairs, farms, sports
  // bars, and museums, opera houses and visitor centers that come up for their music history. Restaurants stay in:
  // plenty of good rooms serve food.
  bigRooms: 'urn:tag:category:place:museum,urn:tag:category:place:history_museum,urn:tag:category:place:visitor_center,urn:tag:category:place:tourist_information_center,urn:tag:category:place:opera_company,urn:tag:category:place:orchestra,urn:tag:category:place:arts_organization,urn:tag:category:place:performing_arts_group,urn:tag:category:place:chapel,urn:tag:category:place:academic_department,urn:tag:category:place:fairground,urn:tag:category:place:recreation_center,urn:tag:category:place:arena,urn:tag:category:place:stadium,urn:tag:category:place:amphitheater,urn:tag:setting:qloo:stadium,urn:tag:setting:qloo:fairgrounds,urn:tag:genre:place:arena,urn:tag:genre:place:stadium,urn:tag:genre:place:amphitheater,urn:tag:category:place:farm,urn:tag:category:place:pumpkin_patch,urn:tag:category:place:wedding_venue,urn:tag:activity_type:qloo:sports_viewing,urn:tag:category:place:sports_bar,urn:tag:decor:qloo:sports_bar_aesthetic,urn:tag:category:place:ice_cream_shop',
};

// The hackathon key allows 5 calls a second, so calls leave at least 220 ms apart. A 429 waits a second and retries
// twice; a 5xx retries once, since Qloo threw a few during testing.
// ponytail: pacing is per isolate; two busy isolates can still collide, which the retries absorb.
let nextSlot = 0;
async function paced(url, init) {
  for (let tries = 0; ; tries++) {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Date.now() + wait + 220;
    await new Promise(r => setTimeout(r, wait));
    const r = await fetch(url, init);
    if (r.status === 429 && tries < 2) nextSlot = Math.max(nextSlot, Date.now() + 1000);
    else if (r.status >= 500 && tries === 0) nextSlot = Math.max(nextSlot, Date.now() + 800);
    else return r;
  }
}

// A plan records every Qloo request it makes so the page can show them. Split invocations run in other isolates, so
// each records its own and hands the list back with its result.
export const traced = env => Object.assign(Object.create(env), { trace: [] });

export async function qloo(env, path, params) {
  const url = `${(env.QLOO_API_URL || BASE).replace(/\/+$/, '')}${path}?${new URLSearchParams(params)}`;
  const cache = globalThis.caches?.default;
  const hit = await cache?.match(url);
  env.trace?.push({ path, params, cached: !!hit });
  if (hit) return hit.json();
  const r = await paced(url, { headers: { 'X-Api-Key': env.QLOO_API_KEY } });
  if (!r.ok) throw new Error(`Qloo ${path} returned ${r.status}`);
  const text = await r.text();
  await cache?.put(url, new Response(text, { headers: { 'Cache-Control': 'max-age=86400' } }));
  return JSON.parse(text);
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const entity = e => ({
  id: e.entity_id,
  name: e.name,
  affinity: e.query?.affinity,
  popularity: e.popularity,
  blurb: clip(e.properties?.short_description || e.properties?.description, 140),
  rating: Math.round(e.properties?.business_rating * 10) / 10 || undefined,
  address: e.properties?.address,
  url: e.properties?.website,
  tags: (e.tags || []).slice(0, 4).map(t => t.name),
});

const insights = async (env, params, keep = () => true) =>
  ((await qloo(env, '/v2/insights', params)).results?.entities || []).filter(keep).map(entity);

const near = (c, km) => ({ 'filter.location': `POINT(${c.lon} ${c.lat})`, 'filter.location.radius': km * 1000 });

const GENRE = /^urn:tag:(sub)?genre:/;
const tagId = t => t.tag_id || t.id || '';
const artistCard = e => ({
  ...entity(e),
  image: e.properties?.image?.url,
  genres: [...new Set((e.tags || []).filter(t => GENRE.test(tagId(t))).map(t => t.name))].slice(0, 4),
});

// Five candidates so the page can ask "which one?" when the top match isn't the name typed. With id, that candidate.
export async function findArtist(env, name, id) {
  const found = (await qloo(env, '/search', { query: name, types: 'urn:entity:artist', take: 5 })).results || [];
  const top = found.find(e => e.entity_id === id) || found[0];
  return top && {
    ...artistCard(top),
    genreIds: (top.tags || []).map(tagId).filter(t => GENRE.test(t)),
    candidates: found.map(artistCard),
  };
}

// Qloo search reads "Portland, Maine" but not "Portland, ME" (that finds a neighborhood), so postal codes are spelled out.
const STATES = Object.fromEntries(('AL Alabama,AK Alaska,AZ Arizona,AR Arkansas,CA California,CO Colorado,CT Connecticut,' +
  'DE Delaware,DC District of Columbia,FL Florida,GA Georgia,HI Hawaii,ID Idaho,IL Illinois,IN Indiana,IA Iowa,KS Kansas,' +
  'KY Kentucky,LA Louisiana,ME Maine,MD Maryland,MA Massachusetts,MI Michigan,MN Minnesota,MS Mississippi,MO Missouri,' +
  'MT Montana,NE Nebraska,NV Nevada,NH New Hampshire,NJ New Jersey,NM New Mexico,NY New York,NC North Carolina,' +
  'ND North Dakota,OH Ohio,OK Oklahoma,OR Oregon,PA Pennsylvania,RI Rhode Island,SC South Carolina,SD South Dakota,' +
  'TN Tennessee,TX Texas,UT Utah,VT Vermont,VA Virginia,WA Washington,WV West Virginia,WI Wisconsin,WY Wyoming')
  .split(',').map(s => [s.slice(0, 2), s.slice(3)]));
export const spellState = q => q.replace(/,?\s+([A-Za-z]{2})\.?$/, (m, st) => (STATES[st.toUpperCase()] ? `, ${STATES[st.toUpperCase()]}` : m));

// US results only, shown as "City, State" from Qloo's "City, County, State, United States of America". The state typed
// counts most, then the exact city name, then Qloo popularity (Austin the city over Austin County).
export function usCity(results, typed = '') {
  const [city, state] = typed.toLowerCase().split(',').map(s => s.trim());
  const where = r => (r.disambiguation || '').toLowerCase();
  const score = r => (state && where(r).endsWith(`${state}, united states of america`) ? 4 : 0) +
    (r.name?.toLowerCase() === city ? 2 : 0) + (r.popularity || 0);
  const c = results.filter(r => where(r).endsWith('united states of america')).sort((a, b) => score(b) - score(a))[0];
  if (!c) return null;
  const parts = c.disambiguation.split(', ');
  return { name: parts.length > 2 ? `${parts[0]}, ${parts.at(-2)}` : c.name, lat: c.location?.lat, lon: c.location?.lon };
}

export async function findCity(env, name) {
  const query = spellState(name);
  const j = await qloo(env, '/search', { query, types: 'urn:entity:locality', take: 4 });
  return usCity(j.results || [], query);
}

// Heavy steps (a heatmap chunk, one stop's places) parse a few hundred KB of JSON each. On Cloudflare they run
// through SPLIT, a binding back to this Worker (src/index.js), so each gets its own 10 ms free-plan CPU budget.
// Without the binding (node dev.js) they run inline.
const split = async (env, name, local, ...args) => {
  const { trace, ...out } = await (env.SPLIT ? env.SPLIT[name](...args) : local(env, ...args));
  env.trace?.push(...trace);
  return out;
};

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
  env = traced(env);
  const j = await qloo(env, '/v2/insights', {
    'filter.type': 'urn:heatmap', 'filter.location': `MULTIPOLYGON(${chunks[i].map(box).join(',')})`, 'signal.interests.entities': id,
  });
  const cells = j.results?.heatmap || [];
  const cities = chunks[i].map(([name, lat, lon]) => {
    const mine = cells.filter(({ location: l }) => l && Math.abs(l.latitude - lat) <= D + 0.01 && Math.abs(l.longitude - lon) <= D * 1.3 + 0.01);
    if (!mine.length) return null;
    const mean = k => mine.reduce((sum, c) => sum + (c.query?.[k] ?? 0), 0) / mine.length;
    const affinity = mean('affinity'), popularity = mean('popularity');
    return { name, lat, lon, affinity, popularity, score: affinity * Math.sqrt(popularity) };
  }).filter(Boolean);
  return { cities, trace: env.trace };
}

// One failed chunk costs a third of the map, not the whole plan.
export async function fanCities(env, id) {
  const done = await Promise.allSettled(chunks.map((_, i) => split(env, 'heat', heatChunk, id, i)));
  const ok = done.filter(r => r.status === 'fulfilled');
  if (!ok.length) throw done[0].reason;
  return { cities: ok.flatMap(r => r.value.cities), failed: done.length - ok.length, chunks: done.length };
}

// Tags miss a few big rooms, so the description gets a look too: arena words, or a stated size of 2,500 seats or more.
// Never the name: Hardcore Stadium is a 100-cap DIY room.
export const bigRoom = d => /\b(arena|stadium|amphitheat|coliseum|fairground)/i.test(d || '') ||
  Number(/\b(\d{1,2},?\d{3})[- ](seat|capacity)/i.exec(d || '')?.[1].replace(',', '')) >= 2500;

export const venues = async (env, id, c) => (await insights(env, {
  'filter.type': 'urn:entity:place', 'filter.tags': TAGS.venue, 'operator.filter.tags': 'union',
  'filter.exclude.tags': TAGS.bigRooms, 'signal.interests.entities': id, ...near(c, 30), take: 6,
}, e => !bigRoom(e.properties?.description))).slice(0, 4);

// Artists this audience also listens to, in the headliner's genres. With a location signal they are local acts worth
// a support slot; without one, acts to share a package tour with. The popularity cap drops acts clearly bigger than
// the headliner (Qloo popularity is a percentile, so it is a loose cap). Eight per stop so the planner can hand each
// act to one stop only.
const peers = (a, extra) => ({
  'filter.type': 'urn:entity:artist', 'signal.interests.entities': a.id, 'filter.exclude.entities': a.id,
  ...(a.popularity && { 'filter.popularity.max': a.popularity }),
  ...(a.genreIds?.length && { 'filter.tags': a.genreIds.join(','), 'operator.filter.tags': 'union' }),
  take: 8, ...extra,
});
export const coBill = (env, a, c) => insights(env, peers(a, { 'signal.location': `POINT(${c.lon} ${c.lat})` }));
export const partners = (env, a) => insights(env, peers(a));

// Record stores, cafes and bookshops this audience already goes to: where the posters and flyers go.
export const posterSpots = (env, id, c) => insights(env, {
  'filter.type': 'urn:entity:place', 'filter.tags': TAGS.spots, 'operator.filter.tags': 'union',
  'signal.interests.entities': id, ...near(c, 15), take: 3,
});

export async function stopInfo(env, a, c) {
  env = traced(env);
  const [venueList, support, spots] = await Promise.all([venues(env, a.id, c), coBill(env, a, c), posterSpots(env, a.id, c)]);
  return { venues: venueList, coBill: support, spots, trace: env.trace };
}

export const stopDetails = (env, a, c) =>
  split(env, 'stop', stopInfo, { id: a.id, popularity: a.popularity, genreIds: a.genreIds }, { lat: c.lat, lon: c.lon });

export const brands = (env, id) => insights(env, { 'filter.type': 'urn:entity:brand', 'signal.interests.entities': id, take: 6 });

export const podcasts = (env, id) => insights(env, { 'filter.type': 'urn:entity:podcast', 'signal.interests.entities': id, take: 5 });

export async function audience(env, id) {
  const j = await qloo(env, '/v2/insights', { 'filter.type': 'urn:demographics', 'signal.interests.entities': id });
  return j.results?.demographics?.[0]?.query || null;
}
