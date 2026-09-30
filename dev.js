// Local server: node dev.js, then open http://localhost:8788
// With QLOO_API_KEY set it calls the real API. Without it, Qloo and the chat model are faked
// so the page can be worked on offline. Deployed builds never load this file.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import worker from './src/worker.js';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
// The key can also sit in .dev.vars (gitignored), the same file wrangler reads: QLOO_API_KEY=...
const devVars = (() => { try { return readFileSync('.dev.vars', 'utf8'); } catch { return ''; } })();

const env = {
  QLOO_API_KEY: process.env.QLOO_API_KEY || /^QLOO_API_KEY\s*=\s*"?([^"\s]+)"?/m.exec(devVars)?.[1],
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
  const CITIES = [
    ['New York', 40.71, -74.01], ['Philadelphia', 39.95, -75.17], ['Boston', 42.36, -71.06], ['Washington', 38.91, -77.04],
    ['Pittsburgh', 40.44, -80.0], ['Richmond', 37.54, -77.44], ['Asheville', 35.6, -82.55], ['Nashville', 36.16, -86.78],
    ['Atlanta', 33.75, -84.39], ['Chicago', 41.88, -87.63], ['Detroit', 42.33, -83.05], ['Columbus', 39.96, -83.0],
    ['Minneapolis', 44.98, -93.27], ['Milwaukee', 43.04, -87.91], ['St. Louis', 38.63, -90.2], ['Kansas City', 39.1, -94.58],
    ['Denver', 39.74, -104.99], ['Boulder', 40.01, -105.27], ['Salt Lake City', 40.76, -111.89], ['Austin', 30.27, -97.74],
    ['Dallas', 32.78, -96.8], ['Houston', 29.76, -95.37], ['New Orleans', 29.95, -90.07], ['Phoenix', 33.45, -112.07],
    ['Los Angeles', 34.05, -118.24], ['San Diego', 32.72, -117.16], ['San Francisco', 37.77, -122.42], ['Portland', 45.52, -122.68],
    ['Seattle', 47.61, -122.33], ['Boise', 43.62, -116.2], ['Albuquerque', 35.08, -106.65], ['Omaha', 41.26, -95.93],
  ];
  const rand = s => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 7) / 2 ** 32;
  const fake = url => {
    const u = new URL(url), p = Object.fromEntries(u.searchParams);
    if (u.pathname === '/search' && p.types.includes('locality')) {
      const c = CITIES.find(([n]) => p.query.toLowerCase().includes(n.toLowerCase()));
      return { results: c ? [{ name: c[0], location: { lat: c[1], lon: c[2] } }] : [] };
    }
    if (u.pathname === '/search') return { results: [{ entity_id: `artist-${p.query}`, name: p.query, popularity: 0.7 }] };
    const type = p['filter.type'];
    if (type === 'urn:heatmap') {
      return { results: { heatmap: CITIES.map(([name, latitude, longitude]) => ({
        location: { name, latitude, longitude },
        query: { affinity: rand(name + p['signal.interests.entities']), popularity: rand(name) },
      })) } };
    }
    if (type === 'urn:demographics') {
      return { results: { demographics: [{ query: { age: { '24_and_younger': 0.1, '25_to_29': 0.3, '30_to_34': 0.2, '35_to_44': -0.1 }, gender: { female: 0.1, male: -0.1 } } }] } };
    }
    const kind = type.split(':').pop();
    const where = p['filter.location'] || p['signal.location'] || '';
    return { results: { entities: [1, 2, 3].map(i => ({
      entity_id: `${kind}-${i}`, name: `Sample ${kind} ${i}${where ? ` near ${where.slice(6, 16)}` : ''}`,
      popularity: rand(kind + i + where), query: { affinity: 1 - i / 10 }, properties: { address: `${i}00 Main St` },
    })) } };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://hackathon.api.qloo.com')
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
