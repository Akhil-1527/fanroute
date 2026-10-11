// Chat agent: a Workers AI model that answers tour questions and changes the tour through Qloo-backed tools.
import * as Q from './qloo.js';
import { clean, planTour } from './plan.js';
import { miles } from './route.js';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SYSTEM = `You help independent musicians plan US tours. Every fact about audiences, cities, venues, artists and
brands must come from the current tour or a tool result; never make one up. To build or change the tour, call plan_tour
with the full settings, keeping the current ones unless the user asks for a change. To look at a city that is not on
the tour, call check_city. Qloo numbers are aggregate taste affinity, never a count of fans, a probability, or a cause.
Say "over-indexes", not "has fans". If a tool returns needs_choice, ask the user which one they meant in one sentence,
listing the names; do not guess. Only describe changes you have made; to suggest one, ask whether to make it. Reply in
two to four short, plain sentences. Never mention tool names. Do not use em dashes.`;

const TOOLS = [
  {
    name: 'plan_tour',
    description: 'Build or rebuild the tour. Picks US cities where the artist\'s audience over-indexes, routes them for a van, and finds rooms, local acts and poster spots.',
    parameters: {
      type: 'object',
      properties: {
        artist: { type: 'string' },
        home: { type: 'string', description: 'Home base city' },
        shows: { type: 'integer', description: 'Number of shows' },
        maxMiles: { type: 'integer', description: 'Most miles to drive in one day' },
        start: { type: 'string', description: 'First show date, YYYY-MM-DD' },
        skip: { type: 'array', items: { type: 'string' }, description: 'City names to leave out' },
      },
      required: ['artist', 'home'],
    },
  },
  {
    name: 'check_city',
    description: 'How one city ranks for the artist, plus its best rooms and local acts.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

// What the model sees of a tour: names and numbers, not raw API payloads.
const affinity = c => Number(c.affinity.toFixed(2));
export const brief = t => JSON.stringify({
  artist: t.artist.name,
  settings: t.params,
  totals: t.totals,
  stops: t.stops.map(s => ({
    city: s.name, date: s.date, qlooAffinity: affinity(s), fanrouteRank: `${s.rank} of ${t.cities.length}`, driveMiles: s.legMiles,
    rooms: s.venues.map(v => v.name), localActs: s.coBill.map(a => a.name), posterSpots: s.spots.map(x => x.name),
  })),
  actsThisAudienceLovesEverywhere: t.partners.map(a => a.name),
  nextBestCities: t.cities.filter(c => !t.stops.some(s => s.name === c.name)).slice(0, 5).map(c => c.name),
  brands: t.brands.map(b => b.name),
  podcasts: t.podcasts.map(p => p.name),
  audience: t.audience,
});

async function checkCity(env, params, city) {
  const [artist, c] = await Promise.all([Q.findArtist(env, params.artist, params.artistId), Q.findCity(env, city)]);
  if (!artist || !c) return { error: 'Artist or city not found.' };
  const { cities } = await Q.fanCities(env, artist.id);
  cities.sort((a, b) => b.score - a.score);
  const i = cities.findIndex(f => miles(f, c) < 50);
  const { venues, coBill: acts } = await Q.stopDetails(env, artist, c);
  return {
    city: c.name,
    ...(i < 0
      ? { fanrouteRank: `not one of the ${cities.length} touring cities Fanroute checks` }
      : { qlooAffinity: affinity(cities[i]), fanrouteRank: `${i + 1} of ${cities.length}` }),
    rooms: venues.map(v => v.name),
    localActs: acts.slice(0, 3).map(a => a.name),
  };
}

const args = a => (typeof a === 'string' ? JSON.parse(a || '{}') : a || {});

export async function ask(env, { messages = [], params = {}, context = '' }) {
  if (!env.AI) return { reply: 'Chat is not switched on here. The form above still plans tours.' };
  // The page sends the current stops as keep. They stay out of the prompt and only seed a replan of the same artist
  // from the same home, so "drop Richmond" changes one city instead of the whole loop.
  let { keep, ...settings } = clean(params);
  params = settings;
  const same = (a, k) => !a[k] || String(a[k]).toLowerCase().split(',')[0].trim() === params[k].toLowerCase().split(',')[0].trim();
  const msgs = [
    { role: 'system', content: `${SYSTEM}\nToday is ${new Date().toISOString().slice(0, 10)}.\nCurrent settings: ${JSON.stringify(params)}\nCurrent tour: ${String(context).slice(0, 6000) || 'none yet'}` },
    ...messages.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 2000) })),
  ];
  let plan;
  // Llama on Workers AI keeps calling tools for as long as they are offered, so only the first turn gets them.
  // It can call several at once there; the second turn has to answer from the results.
  for (let turn = 0; turn < 2; turn++) {
    const r = await env.AI.run(MODEL, { messages: msgs, ...(turn === 0 && { tools: TOOLS }) });
    if (!r.tool_calls?.length) return { reply: r.response, plan };
    for (const call of r.tool_calls) {
      let out;
      try {
        if (call.name === 'plan_tour') {
          const a = args(call.arguments);
          const next = await planTour(env, { ...params, ...a, keep: same(a, 'artist') && same(a, 'home') ? keep : [] });
          if (next.choose) {
            out = { needs_choice: next.choose.map(c => ({ name: c.name, about: c.blurb })) };
          } else {
            plan = next;
            params = plan.params;
            keep = plan.stops.map(s => s.name);
            plan.brief = brief(plan);
            out = plan.brief;
          }
        } else if (call.name === 'check_city') {
          out = await checkCity(env, params, args(call.arguments).city);
        } else {
          out = { error: `No tool called ${call.name}.` };
        }
      } catch (e) {
        out = { error: e.message };
      }
      msgs.push({ role: 'tool', name: call.name, content: typeof out === 'string' ? out : JSON.stringify(out) });
    }
  }
  return { reply: 'That took more steps than I allow. Try a smaller question.', plan };
}
