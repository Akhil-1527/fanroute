// Tour routing: pick the fan cities a van can reach and put them in driving order.
const EARTH_MILES = 3958.8;
const ROAD = 1.2; // road miles per straight-line mile, rough US average
const RADIUS = 50; // venue radius clauses usually bar a second show within about 50 miles

export function miles(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.sqrt(h));
}

export const roadMiles = (a, b) => miles(a, b) * ROAD;

// Cheapest insertion by value: each step adds the city with the best fan score per added mile,
// keeping every leg (the drive out and back home included) within two driving days.
// ponytail: greedy + 2-opt, not optimal; fine for 20 stops, use a solver if tours get much longer.
export function route(cities, home, { shows = 8, maxMiles = 350 } = {}) {
  const maxLeg = 2 * maxMiles;
  const tour = [home, home];
  const left = cities.filter(c => c.score > 0);
  while (tour.length - 2 < shows) {
    let best;
    for (const c of left) {
      if (tour.slice(1, -1).some(s => miles(s, c) < RADIUS)) continue;
      for (let i = 0; i < tour.length - 1; i++) {
        const a = tour[i], b = tour[i + 1];
        if (roadMiles(a, c) > maxLeg || roadMiles(c, b) > maxLeg) continue;
        const added = roadMiles(a, c) + roadMiles(c, b) - roadMiles(a, b);
        const value = c.score / (1 + added / maxMiles);
        if (!best || value > best.value) best = { c, i, value };
      }
    }
    if (!best) break;
    tour.splice(best.i + 1, 0, best.c);
    left.splice(left.indexOf(best.c), 1);
  }
  twoOpt(tour, maxLeg);
  return tour.slice(1, -1);
}

// Uncross the loop. Reversing a stretch keeps its inner legs, so only the two new legs need checking.
function twoOpt(t, maxLeg) {
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < t.length - 3; i++) {
      for (let j = i + 2; j < t.length - 1; j++) {
        const [a, b, c, d] = [t[i], t[i + 1], t[j], t[j + 1]];
        const ac = roadMiles(a, c), bd = roadMiles(b, d);
        if (ac + bd < roadMiles(a, b) + roadMiles(c, d) - 1e-6 && ac <= maxLeg && bd <= maxLeg) {
          t.splice(i + 1, j - i, ...t.slice(i + 1, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
}

// First show on start, then a day per maxMiles of driving between shows (long jumps get an off day).
export function schedule(stops, home, start, maxMiles = 350) {
  const day = new Date(`${start}T12:00:00Z`);
  let prev = home;
  return stops.map((s, i) => {
    const leg = Math.round(roadMiles(prev, s));
    if (i) day.setUTCDate(day.getUTCDate() + Math.max(1, Math.ceil(leg / maxMiles)));
    prev = s;
    return { ...s, date: day.toISOString().slice(0, 10), legMiles: leg, driveHours: Math.round(leg / 55 * 10) / 10 };
  });
}
