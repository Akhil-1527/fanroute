# Fanroute

Plan a van tour through the US cities where your fans already are.

Type an artist and a home base. Fanroute asks Qloo where that artist's fans over-index, routes the best cities into a
loop a van can actually drive, and for every stop finds venues, local support acts and poster spots that the same fans
already go to. A chat agent can change the plan ("drop Chicago", "is Boise worth it?") by calling the same Qloo tools.

## How it works

1. Qloo search finds the artist and the home city.
2. A Qloo heatmap with city boundaries scores US cities by fan affinity, weighted toward places big enough to fill a room.
3. The router adds cities by fan score per added mile, keeps every drive within two days, skips a second show inside
   the usual 50 mile radius clause, and uncrosses the loop (`src/route.js`).
4. For each stop, Qloo insights return venues and poster spots near the city ranked by affinity with the artist, and
   artists the local fans also love (support act ideas).
5. Qloo demographics, brands and podcasts show who the fans are and who to pitch for sponsorship and press.
6. The chat agent runs on Workers AI with two tools, `plan_tour` and `check_city`, and every fact it states comes
   from those tools.

## Run it locally

Needs Node 20 or newer. No packages to install.

```
node dev.js                          # fake data, no key needed
QLOO_API_KEY=your-key node dev.js    # real Qloo data
npm run check                        # routing checks
```

Then open http://localhost:8788. Without a key, Qloo and the chat model are faked so the page can be worked on offline.

## Deploy

Runs on the Cloudflare Workers free tier (static page, one Worker, Workers AI).

```
npx wrangler secret put QLOO_API_KEY
npx wrangler deploy
```

## Limits

- Affinity is taste data, not ticket sales. Treat a high rank as a lead worth a pitch, not a promise.
- Road miles are straight-line miles times 1.2, so drive times are rough.
- Contiguous US only.

## License

MIT
