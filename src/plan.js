import * as Q from './qloo.js';
import { CITIES } from './cities.js';
import { roadMiles, route, schedule } from './route.js';

const DAY = 864e5;

// Request settings come from the browser or the chat model, so bound every field.
export const clean = p => ({
  artist: String(p.artist ?? '').trim().slice(0, 100),
  // Qloo entity id from the "which one?" picker. Only ever compared against search results.
  artistId: /^[0-9A-F-]{8,64}$/i.test(p.artistId) ? p.artistId : undefined,
  home: String(p.home ?? '').trim().slice(0, 100),
  // 14 shows keeps a plan near 50 Qloo calls, the Workers free-plan subrequest cap.
  shows: Math.min(14, Math.max(1, Math.round(p.shows) || 8)),
  maxMiles: Math.min(800, Math.max(100, Math.round(p.maxMiles) || 350)),
  start: /^\d{4}-\d{2}-\d{2}$/.test(p.start) ? p.start : new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10),
  skip: Array.isArray(p.skip) ? p.skip.slice(0, 30).map(s => String(s).slice(0, 100)) : [],
  // Stops of the plan being edited, by name, so an edit keeps them.
  keep: Array.isArray(p.keep) ? p.keep.slice(0, 14).map(s => String(s).slice(0, 100)) : [],
});

const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// "Wednesday band" finds Band of Horses first. When the top match isn't the name typed, ask before spending 30 calls.
export const needsConfirm = (query, candidates) => candidates.length > 1 && norm(candidates[0].name) !== norm(query);

// Each local act goes to the one stop where it scores highest, so the same name doesn't fill every stop. A stop can
// end up with fewer than n; that beats padding it with acts that fit it worse.
export function dedupe(stops, n = 3) {
  const pairs = stops.flatMap((s, i) => (s.coBill || []).map(a => ({ i, a })));
  pairs.sort((x, y) => (y.a.affinity ?? 0) - (x.a.affinity ?? 0) || x.i - y.i);
  const used = new Set(), keep = stops.map(() => new Set());
  for (const { i, a } of pairs) {
    // Qloo sometimes has two entities for one act, so the name counts as well as the id.
    if (keep[i].size >= n || used.has(a.id) || used.has(norm(a.name))) continue;
    used.add(a.id).add(norm(a.name));
    keep[i].add(a);
  }
  stops.forEach((s, i) => { s.coBill = (s.coBill || []).filter(a => keep[i].has(a)); });
  return stops;
}

// Every stage reports through step() so the page can show what the agent is doing.
export async function planTour(env, params, step = () => {}) {
  env = Q.traced(env);
  const p = clean(params);
  if (!p.artist || !p.home) throw new Error('Need an artist and a home base.');
  step(`Looking up ${p.artist} and ${p.home} in Qloo`);
  const [artist, home] = await Promise.all([Q.findArtist(env, p.artist, p.artistId), Q.findCity(env, p.home)]);
  if (!artist) throw new Error(`Qloo has no artist called "${p.artist}".`);
  if (!home) throw new Error(`Could not find a US city called "${p.home}". Try the city and state.`);
  if (artist.id !== p.artistId && needsConfirm(p.artist, artist.candidates)) return { choose: artist.candidates, query: p.artist };
  const others = artist.candidates.length - 1;
  step(`Matched "${p.artist}" to ${artist.name}${artist.genres[0] ? ` (${artist.genres[0].toLowerCase()})` : ''}.${others ? ` ${others} other matches, shown above the map.` : ''}`);

  step(`Asking Qloo where the taste audience for ${artist.name} over-indexes across ${CITIES.length} US cities`);
  const { cities, failed, chunks } = await Q.fanCities(env, artist.id);
  cities.sort((a, b) => b.score - a.score).forEach((c, i) => { c.rank = i + 1; });
  if (failed) step(`${failed} of ${chunks} map chunks failed, ranking covers ${cities.length} cities`);
  if (!cities.length) throw new Error(`Qloo has no city data for ${artist.name} yet.`);

  step(`Routing ${p.shows} dates from ${home.name}, at most ${p.maxMiles} miles a day`);
  // Real affinity spreads are narrow, so short drives would win every time. Only the top third of cities are
  // candidates; the router then trades score against miles inside that set.
  // "Boston" from the chat should drop "Boston, MA".
  const skip = p.skip.map(x => x.toLowerCase().split(',')[0].trim()).filter(Boolean);
  const skipped = c => skip.some(x => c.name.toLowerCase().startsWith(x));
  const open = cities.filter(c => c.rank <= Math.ceil(cities.length / 3) && !skipped(c));
  // Kept stops beyond the show count lose the lowest scores first and keep their driving order.
  const kept = p.keep.map(n => cities.find(c => c.name === n)).filter(c => c && !skipped(c));
  const top = new Set([...kept].sort((a, b) => b.score - a.score).slice(0, p.shows));
  const stops = schedule(route(open, home, { ...p, seed: kept.filter(c => top.has(c)) }), home, p.start, p.maxMiles);
  if (stops.length < p.shows) step(`Only ${stops.length} of the top cities fit within two driving days of each other`);

  // One stop at a time keeps the three calls per stop under the key's 5 calls a second.
  for (const [i, s] of stops.entries()) {
    step(`Asking Qloo for small rooms, local acts and poster spots in ${s.name} (${i + 1} of ${stops.length})`);
    Object.assign(s, await Q.stopDetails(env, artist, s));
  }
  dedupe(stops);

  step('Asking Qloo for the audience profile, brands, podcasts and acts this audience loves everywhere');
  const [audience, brands, podcasts, partners] = await Promise.all([
    Q.audience(env, artist.id), Q.brands(env, artist.id), Q.podcasts(env, artist.id), Q.partners(env, artist),
  ]);

  const last = stops.at(-1);
  const driveHome = last ? Math.round(roadMiles(last, home)) : 0;
  return {
    // The matched id rides along so a chat edit replans the same artist without asking again.
    params: { ...p, artistId: artist.id, keep: undefined }, artist, home, cities, stops, audience, brands, podcasts, partners,
    trace: env.trace,
    totals: {
      shows: stops.length,
      days: last ? (Date.parse(last.date) - Date.parse(stops[0].date)) / DAY + 1 : 0,
      miles: stops.reduce((m, s) => m + s.legMiles, driveHome),
      driveHome,
    },
  };
}
