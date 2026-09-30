import * as Q from './qloo.js';
import { roadMiles, route, schedule } from './route.js';

const DAY = 864e5;

// Request settings come from the browser or the chat model, so bound every field.
export const clean = p => ({
  artist: String(p.artist ?? '').trim().slice(0, 100),
  home: String(p.home ?? '').trim().slice(0, 100),
  shows: Math.min(20, Math.max(1, Math.round(p.shows) || 8)),
  maxMiles: Math.min(800, Math.max(100, Math.round(p.maxMiles) || 350)),
  start: /^\d{4}-\d{2}-\d{2}$/.test(p.start) ? p.start : new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10),
  skip: Array.isArray(p.skip) ? p.skip.slice(0, 30).map(s => String(s).slice(0, 100)) : [],
});

// Every stage reports through step() so the page can show what the agent is doing.
export async function planTour(env, params, step = () => {}) {
  const p = clean(params);
  if (!p.artist || !p.home) throw new Error('Need an artist and a home base.');
  step(`Looking up ${p.artist} and ${p.home} in Qloo`);
  const [artist, home] = await Promise.all([Q.findArtist(env, p.artist), Q.findCity(env, p.home)]);
  if (!artist) throw new Error(`Qloo has no artist called "${p.artist}".`);
  if (!home) throw new Error(`Could not place "${p.home}" on the map.`);

  step(`Mapping where fans of ${artist.name} over-index across the US`);
  const cities = (await Q.fanCities(env, artist.id)).sort((a, b) => b.score - a.score);
  cities.forEach((c, i) => { c.rank = i + 1; });
  if (!cities.length) throw new Error(`Qloo has no city data for ${artist.name} yet.`);

  step(`Routing ${p.shows} dates from ${home.name}, at most ${p.maxMiles} miles a day`);
  const open = cities.filter(c => !p.skip.includes(c.name));
  const stops = schedule(route(open, home, p), home, p.start, p.maxMiles);

  step(`Finding venues, support acts and poster spots in ${stops.length} cities`);
  await Promise.all(stops.map(async s => {
    [s.venues, s.coBill, s.spots] = await Promise.all([
      Q.venues(env, artist.id, s), Q.coBill(env, artist.id, s), Q.posterSpots(env, artist.id, s),
    ]);
  }));

  step('Reading who the fans are and which brands they share');
  const [audience, brands, podcasts] = await Promise.all([
    Q.audience(env, artist.id), Q.brands(env, artist.id), Q.podcasts(env, artist.id),
  ]);

  const last = stops.at(-1);
  const driveHome = last ? Math.round(roadMiles(last, home)) : 0;
  return {
    params: p, artist, home, cities, stops, audience, brands, podcasts,
    totals: {
      shows: stops.length,
      days: last ? (Date.parse(last.date) - Date.parse(stops[0].date)) / DAY + 1 : 0,
      miles: stops.reduce((m, s) => m + s.legMiles, driveHome),
      driveHome,
    },
  };
}
