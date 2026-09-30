// Chat agent: a Workers AI model that answers tour questions and changes the tour through Qloo-backed tools.
import * as Q from './qloo.js';
import { clean, planTour } from './plan.js';
import { miles } from './route.js';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SYSTEM = `You help independent musicians plan US tours. Every fact about fans, cities, venues, artists and brands
must come from the current tour or a tool result; never make one up. To build or change the tour, call plan_tour with
the full settings, keeping the current ones unless the user asks for a change. To look at a city that is not on the
tour, call check_city. Reply in two to four short, plain sentences. Do not use em dashes.`;

const TOOLS = [
  {
    name: 'plan_tour',
    description: 'Build or rebuild the tour. Picks US cities where fans of the artist over-index, routes them for a van, and finds venues, support acts and poster spots.',
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
    description: 'How one city ranks for the artist, plus its best venues and support acts.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

// What the model sees of a tour: names and ranks, not raw API payloads.
export const brief = t => JSON.stringify({
  artist: t.artist.name,
  settings: t.params,
  totals: t.totals,
  stops: t.stops.map(s => ({
    city: s.name, date: s.date, fanRank: `${s.rank} of ${t.cities.length}`, driveMiles: s.legMiles,
    venues: s.venues.map(v => v.name), support: s.coBill.map(a => a.name), posters: s.spots.map(x => x.name),
  })),
  nextBestCities: t.cities.filter(c => !t.stops.some(s => s.name === c.name)).slice(0, 5).map(c => c.name),
  brands: t.brands.map(b => b.name),
  podcasts: t.podcasts.map(p => p.name),
  audience: t.audience,
});

async function checkCity(env, params, city) {
  const [artist, c] = await Promise.all([Q.findArtist(env, params.artist), Q.findCity(env, city)]);
  if (!artist || !c) return { error: 'Artist or city not found.' };
  const fans = (await Q.fanCities(env, artist.id)).sort((a, b) => b.score - a.score);
  const i = fans.findIndex(f => miles(f, c) < 50);
  const [venues, support] = await Promise.all([Q.venues(env, artist.id, c), Q.coBill(env, artist.id, c)]);
  return {
    city: c.name,
    fanRank: i < 0 ? `not in the top ${fans.length} US cities` : `${i + 1} of ${fans.length}`,
    venues: venues.map(v => v.name),
    support: support.map(a => a.name),
  };
}

const args = a => (typeof a === 'string' ? JSON.parse(a || '{}') : a || {});

export async function ask(env, { messages = [], params = {}, context = '' }) {
  if (!env.AI) return { reply: 'Chat is not switched on here. The form above still plans tours.' };
  const msgs = [
    { role: 'system', content: `${SYSTEM}\nToday is ${new Date().toISOString().slice(0, 10)}.\nCurrent settings: ${JSON.stringify(clean(params))}\nCurrent tour: ${String(context).slice(0, 6000) || 'none yet'}` },
    ...messages.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 2000) })),
  ];
  let plan;
  for (let turn = 0; turn < 4; turn++) {
    const r = await env.AI.run(MODEL, { messages: msgs, tools: TOOLS });
    if (!r.tool_calls?.length) return { reply: r.response, plan };
    for (const call of r.tool_calls) {
      let out;
      try {
        if (call.name === 'plan_tour') {
          plan = await planTour(env, { ...params, ...args(call.arguments) });
          params = plan.params;
          plan.brief = brief(plan);
          out = plan.brief;
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
