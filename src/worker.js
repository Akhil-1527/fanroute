import { ask, brief } from './agent.js';
import { planTour } from './plan.js';

// Streams one JSON object per line: {step} while working, then {plan}, {choose} (which artist did you mean) or {error}.
function streamPlan(env, params) {
  const { readable, writable } = new TransformStream();
  const out = writable.getWriter();
  const send = o => out.write(new TextEncoder().encode(`${JSON.stringify(o)}\n`));
  (async () => {
    try {
      const plan = await planTour(env, params, step => send({ step }));
      if (plan.choose) {
        await send(plan);
      } else {
        plan.brief = brief(plan);
        await send({ plan });
      }
    } catch (e) {
      await send({ error: e.message });
    }
    await out.close();
  })();
  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      const body = await req.json().catch(() => ({}));
      if (pathname === '/api/plan') return streamPlan(env, body);
      if (pathname === '/api/ask') {
        try {
          return Response.json(await ask(env, body));
        } catch (e) {
          return Response.json({ reply: `Something broke on my side (${e.message}). The form above still works.` });
        }
      }
    }
    return env.ASSETS.fetch(req);
  },
};
