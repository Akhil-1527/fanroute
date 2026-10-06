// Local server: node dev.js, then open http://localhost:8788
// With QLOO_API_KEY set it calls the real API. Without it, Qloo and the chat model are faked
// so the page can be worked on offline. Deployed builds never load this file.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import worker from './src/worker.js';
import { CITIES } from './src/cities.js';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
// Key and URL can also sit in .dev.vars (gitignored), the same file wrangler reads: QLOO_API_KEY=... QLOO_API_URL=...
const devVars = (() => { try { return readFileSync('.dev.vars', 'utf8'); } catch { return ''; } })();
const devVar = k => process.env[k] || new RegExp(`^${k}\\s*=\\s*"?([^"\\s]+)"?`, 'm').exec(devVars)?.[1];

const env = {
  QLOO_API_KEY: devVar('QLOO_API_KEY'),
  QLOO_API_URL: devVar('QLOO_API_URL'),
  ASSETS: {
    async fetch(req) {
      const path = normalize(new URL(req.url).pathname).replace(/^(\.\.[/\\])+/, '');
      try {
        const file = join('public', path.endsWith('/') ? `${path}index.html` : path);
        return new Response(await readFile(file), { headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  },
};

if (!env.QLOO_API_KEY) {
  const rand = s => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 7) / 2 ** 32;
  const fake = url => {
    const u = new URL(url), p = Object.fromEntries(u.searchParams);
    if (u.pathname === '/search' && p.types.includes('locality')) {
      const c = CITIES.find(([n]) => n.toLowerCase().startsWith(p.query.toLowerCase().split(',')[0].trim()));
      const [city, st] = c?.[0].split(', ') || [];
      return { results: c ? [{ name: city, disambiguation: `${city}, Sample County, ${st}, United States of America`, location: { lat: c[1], lon: c[2] } }] : [] };
    }
    if (u.pathname === '/search') {
      // A query with "band" in it gets a wrong first match, so the "which one?" picker can be tried offline.
      const names = /band/i.test(p.query) ? ['Band of Horses', 'The Band', p.query, 'Steve Miller Band', 'Dave Matthews Band'] : [p.query, `${p.query} 13`];
      return { results: names.map((name, i) => ({
        entity_id: `0000000${i}-FA4E-0000-0000-${String(name.length).padStart(12, '0')}`, name, popularity: 0.9 - i / 10,
        tags: [{ name: 'Indie Rock', tag_id: 'urn:tag:genre:indie_rock' }], properties: { short_description: `Sample description of ${name}.` },
      })) };
    }
    const type = p['filter.type'];
    if (type === 'urn:heatmap') {
      return { results: { heatmap: CITIES.map(([name, latitude, longitude]) => ({
        location: { latitude: latitude + 0.01, longitude: longitude - 0.01 },
        query: { affinity: rand(name + p['signal.interests.entities']), popularity: rand(name) },
      })) } };
    }
    if (type === 'urn:demographics') {
      return { results: { demographics: [{ query: { age: { '24_and_younger': 0.1, '25_to_29': 0.3, '30_to_34': 0.2, '35_to_44': -0.1 }, gender: { female: 0.1, male: -0.1 } } }] } };
    }
    const kind = type.split(':').pop();
    const where = p['filter.location'] || p['signal.location'] || '';
    // Artists repeat across cities on purpose so the planner's one-stop-per-act rule shows.
    const name = i => (kind === 'artist' ? `Sample act ${Math.floor(rand(where + i) * 15)}` : `Sample ${kind} ${i}${where ? ` near ${where.slice(6, 16)}` : ''}`);
    return { results: { entities: Array.from({ length: Math.min(Number(p.take) || 3, 8) }, (_, i) => ({
      entity_id: `${kind}-${name(i)}`, name: name(i), popularity: rand(kind + i + where), query: { affinity: rand(where + i) },
      properties: { address: `${i + 1}00 Main St`, description: `Sample ${kind} description.`, business_rating: 4.2, website: 'https://example.com/' },
    })).sort((a, b) => b.query.affinity - a.query.affinity) } };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith(env.QLOO_API_URL || 'https://hackathon.api.qloo.com')
    ? new Response(JSON.stringify(fake(String(url))))
    : realFetch(url, init));

  // Fake model: plans on the first turn, then answers from the tool result.
  env.AI = {
    async run(model, { messages }) {
      const last = messages.at(-1);
      if (last.role === 'tool') return { response: `Done. ${JSON.parse(last.content).stops?.length ?? 0} stops on the new plan.` };
      return { tool_calls: [{ name: 'plan_tour', arguments: { artist: 'Sample Artist', home: 'Denver', shows: 6 } }] };
    },
  };
  console.log('No QLOO_API_KEY: using fake Qloo data and a fake chat model.');
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(`http://localhost${req.url}`, {
    method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
  }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (r.body) for await (const c of r.body) res.write(c);
  res.end();
}).listen(8788, () => console.log('http://localhost:8788'));
