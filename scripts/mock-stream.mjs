// Throwaway: a mock of the world's HTTP surface for developing the site
// against /api/stream before the real service lands. Serves site/ at the
// root the way the world does, plus /api/journal, /api/config, /api/stream,
// /api/fly/:id/fired. Not part of the product.
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

const PORT = Number(process.env.PORT || 8790);
const SITE = new URL("../site/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm", ".png": "image/png" };

const NODES = 166691, EDGES = 6242118, FLOOR = 128, LAYERS = 16;
const ARENA = {
  floor: FLOOR, layers: LAYERS,
  dishes: [
    { kind: "yeast", x: 34, y: 40, r: 7, h: 1 },
    { kind: "yeast", x: 96, y: 30, r: 6, h: 1 },
    { kind: "banana", x: 92, y: 86, r: 9, h: 1 },
    { kind: "banana", x: 40, y: 100, r: 7, h: 1 },
    { kind: "water", x: 64, y: 64, r: 6, h: 0 },
  ],
  lamp: { x: 80, y: 44, z: 16 },
  temp: { cold: [0, 64], hot: [128, 64] },
  humidity: { dry: [128, 0] },
};
const ROLE_COUNTS = { 0: 120000, 1: 2600, 2: 400, 3: 300, 4: 480, 5: 3000, 6: 1800, 7: 40, 8: 40, 9: 30, 10: 12000, 11: 1600, 12: 80, 13: 300, 14: 250, 15: 60, 20: 90, 21: 100, 22: 110, 23: 90, 24: 100, 25: 110, 26: 30, 27: 30, 28: 40, 29: 40, 30: 12, 31: 12, 32: 24, 33: 60, 34: 80, 40: 600, 41: 600, 42: 100, 43: 1400, 50: 60 };
const GROUPS = { sens: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], dn: [40, 41, 42], legL: [20, 21, 22], legR: [23, 24, 25], wingP: [26, 27], wingS: [28, 29], prob: [33] };

// ---- the mock world ----
let tick = 100000;
const TICKRATE = 20;
const flies = [];
let nextUid = 40;
const rnd = (a, b) => a + Math.random() * (b - a);
const SURF = { floor: 0, "wall-x0": 1, "wall-x1": 2, "wall-y0": 3, "wall-y1": 4, ceiling: 5 };
function spawn(slot) {
  const f = {
    id: nextUid++, slot, mode: 0, surf: "floor", x: rnd(10, 118), y: rnd(10, 118), z: 0, h: rnd(0, Math.PI * 2), p: 0, r: 0,
    e: Math.floor(rnd(20000, 60000)), wb: 0, legs: [0, 128, 0, 128, 0, 128], pr: 0, speed: 0, turn: 0, phase: 0, timer: rnd(40, 200), vz: 0,
    gen: Math.floor(rnd(0, 4)), born: tick - Math.floor(rnd(0, 20000)),
  };
  flies.push(f);
  return f;
}
for (let s = 0; s < 14; s++) spawn(s);
// two flies parked on the wall and ceiling from the start
flies[1].surf = "wall-x0"; flies[1].x = 0; flies[1].y = 50; flies[1].z = 8; flies[1].stay = true;
flies[2].surf = "ceiling"; flies[2].z = LAYERS; flies[2].x = 60; flies[2].y = 70; flies[2].stay = true;
flies[3].mode = 1; flies[3].z = 7; flies[3].p = 0.1;
const events = [];
function dishAt(x, y) { return ARENA.dishes.find(d => Math.hypot(d.x - x, d.y - y) < d.r); }
function stepFly(f) {
  f.timer--;
  if (f.timer <= 0) {
    f.timer = rnd(30, 260);
    const r = Math.random();
    if (f.mode === 0) {
      if (r < 0.12 && !f.stay) { f.mode = 1; f.vz = 0.25; f.p = 0.35; f.surf = null; }
      else if (r < 0.6) { f.speed = rnd(0.05, 0.22); f.turn = rnd(-0.03, 0.03); }
      else { f.speed = 0; f.turn = 0; }
    } else {
      if (r < 0.3) f.landing = true;
      else { f.turn = rnd(-0.06, 0.06); f.vz = rnd(-0.08, 0.08); }
    }
  }
  if (f.mode === 0) {
    f.h += f.turn;
    const d = dishAt(f.x, f.y);
    if (f.surf === "floor") {
      f.x += Math.cos(f.h) * f.speed; f.y += Math.sin(f.h) * f.speed;
      if (f.x < 0) { f.x = 0; f.surf = "wall-x0"; f.z = 0.5; }
      else if (f.x > FLOOR) { f.x = FLOOR; f.surf = "wall-x1"; f.z = 0.5; }
      else if (f.y < 0) { f.y = 0; f.surf = "wall-y0"; f.z = 0.5; }
      else if (f.y > FLOOR) { f.y = FLOOR; f.surf = "wall-y1"; f.z = 0.5; }
      f.z = d ? d.h : 0;
      // feeding on a dish: proboscis out, no walking
      if (d && d.kind !== "water" && Math.random() < 0.02) { f.speed = 0; f.turn = 0; f.timer = 200; }
      f.pr += (((d && f.speed === 0) ? 1 : 0) - f.pr) * 0.08;
    } else if (f.surf === "ceiling") {
      f.x += Math.cos(f.h) * f.speed; f.y += Math.sin(f.h) * f.speed;
      f.x = Math.max(4, Math.min(FLOOR - 4, f.x)); f.y = Math.max(4, Math.min(FLOOR - 4, f.y));
    } else {
      // a wall: heading is measured in the wall plane; `along` moves x or y,
      // z climbs with sin(h)
      const along = Math.cos(f.h) * f.speed, up = Math.sin(f.h) * f.speed * 0.5;
      if (f.surf === "wall-x0" || f.surf === "wall-x1") f.y = Math.max(4, Math.min(FLOOR - 4, f.y + along)); else f.x = Math.max(4, Math.min(FLOOR - 4, f.x + along));
      f.z += up;
      if (f.stay) f.z = Math.max(2, Math.min(LAYERS - 2, f.z));
      if (f.z <= 0) { f.z = 0; f.surf = "floor"; }
      if (f.z >= LAYERS) { f.z = LAYERS; f.surf = "ceiling"; }
    }
    const step = f.speed * 6;
    for (let k = 0; k < 6; k++) f.legs[k] = (f.legs[k] + step * 255 / 6) % 256;
  } else {
    f.h += f.turn;
    f.x += Math.cos(f.h) * 0.45; f.y += Math.sin(f.h) * 0.45; f.z += f.vz;
    if (f.landing) { f.vz = -0.12; f.p = -0.2; }
    if (f.x < 2 || f.x > FLOOR - 2) { f.h = Math.PI - f.h; f.x = Math.max(2, Math.min(FLOOR - 2, f.x)); }
    if (f.y < 2 || f.y > FLOOR - 2) { f.h = -f.h; f.y = Math.max(2, Math.min(FLOOR - 2, f.y)); }
    if (f.z >= LAYERS - 0.3) { f.z = LAYERS - 0.3; f.vz = -0.05; }
    if (f.z <= 0.2) { f.z = 0; f.mode = 0; f.surf = "floor"; f.landing = false; f.p = 0; f.speed = 0; f.vz = 0; f.timer = 60; }
    f.p += ((f.vz * 2.5) - f.p) * 0.1;
    f.r += ((-f.turn * 9) - f.r) * 0.1;
    f.wb = (f.wb + 0.37) % 1;
    f.e -= 3;
    for (let k = 0; k < 6; k++) f.legs[k] = 96 + (k % 2) * 8;
  }
  f.e = Math.max(0, f.e - 1);
  if (f.e === 0) return false;
  return true;
}
function frame() {
  const evs = [];
  for (let i = flies.length - 1; i >= 0; i--) {
    if (!stepFly(flies[i])) { evs.push({ tick, kind: 2, name: "death", uid: flies[i].id, cause: "starved" }); const s = flies[i].slot; flies.splice(i, 1); const nf = spawn(s); evs.push({ tick, kind: 1, name: "birth", uid: nf.id, cause: null }); }
  }
  if (Math.random() < 0.002) evs.push({ tick, kind: 4, name: "bloom", uid: -1, cause: null });
  const day = (tick % 16384) / 16384;
  const light = process.env.LIGHT !== undefined ? Number(process.env.LIGHT) : Math.round(128 + 127 * Math.cos(day * Math.PI * 2));
  return {
    t: tick, light, temp: Math.round(2400 + 300 * Math.sin(tick / 4000)),
    flies: flies.map(f => ({
      id: f.id, slot: f.slot, mode: f.mode, s: f.mode ? -1 : SURF[f.surf], x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3), h: +((f.h % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)).toFixed(4), p: +f.p.toFixed(3), r: +(f.mode ? f.r : 0).toFixed(3), e: f.e, wb: +f.wb.toFixed(3),
      legs: f.legs.map(v => Math.round(v)), pr: +f.pr.toFixed(3), gen: f.gen, lin: f.id % 5, age: tick - f.born,
      fired: { sens: Math.floor(rnd(200, 900)), dn: Math.floor(rnd(5, 60)), legL: Math.floor(rnd(0, 30) * (f.mode === 0 ? f.speed * 5 + 0.2 : 0.1)), legR: Math.floor(rnd(0, 30) * (f.mode === 0 ? f.speed * 5 + 0.2 : 0.1)), wingP: f.mode ? Math.floor(rnd(10, 30)) : 0, wingS: f.mode ? Math.floor(rnd(2, 20)) : 0, prob: f.pr > 0.5 ? Math.floor(rnd(2, 12)) : 0 },
    })),
    events: evs,
  };
}
const clients = new Set();
setInterval(() => {
  tick += 2;
  const fr = frame();
  const data = `data: ${JSON.stringify(fr)}\n\n`;
  for (const res of clients) res.write(data);
}, 100);

const journal = () => ({
  name: "instar", cluster: "localnet", tick, tickrate: TICKRATE, epochInterval: 2400, epoch: Math.floor(tick / 2400), seed: "1234567890",
  programId: "75rMBkMockProgramIdxxxxxxxxxxxxxxxxxxxxW4NLcM", worldPda: "WorldPdaMockxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1", operator: "OperatorMockxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1",
  capacity: 40, metabolism: 1_200_000_000, pool: 400_000_000, operatorBalance: 9_000_000_000, pendingOps: 0, settling: true,
  entries: [], epochs: [{ epoch: 49, tick: 117600, hash: "9f3a1c2e77b04d15", sig: "5EGTTcjcMockSigxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxc29KqE9C" }],
  txlog: [{ kind: "epoch", sig: "5EGTTcjcMockSigxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxc29KqE9C", t: Date.now() - 60000, ok: true }],
  flies: flies.map((f, i) => ({ id: f.id, parentId: i % 3 ? f.id - 7 : -1, generation: f.gen, status: i % 4 === 0 ? 1 : i % 4 === 1 ? 2 : 3, keeper: i % 4 === 1 ? "rfMmoLpM36dQ6gqFYuLvQpXfCy4qbvx1TNKvFXVorsE" : null, vault: 12_000_000 * (i + 1), salePrice: i % 4 === 0 ? 10_000_000 : 0, pendingCull: false, asset: null, lineage: f.id % 5 })),
  lineageNames: {}, stats: {}, explorer: "https://explorer.solana.com", explorerQuery: "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899",
  verifier: { at: new Date(Date.now() - 3600_000).toISOString(), epoch: 49, epochs: 12, hash: "9f3a1c2e77b04d15", verdict: "VERIFIED", sig: "5EGTTcjcMockSigxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxc29KqE9C" },
});
const config = () => ({
  cluster: "localnet", programId: "75rMBkMockProgramIdxxxxxxxxxxxxxxxxxxxxW4NLcM", collection: "CollectionMockxxxxxxxxxxxxxxxxxxxxxxxxxxxx1", rpc: "http://127.0.0.1:8899",
  explorerQuery: "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899", googleClientId: "",
  nodes: NODES, edges: EDGES, roleCounts: ROLE_COUNTS, groups: GROUPS, arena: ARENA, tickrate: TICKRATE, epochInterval: 2400, maxPop: 40,
  world: null,
});

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const json = (o) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" }); res.end(JSON.stringify(o)); };
  if (p === "/api/journal") return json(journal());
  if (p === "/api/config") return json(config());
  if (p === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    res.write(`data: ${JSON.stringify(frame())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  let m = p.match(/^\/api\/fly\/(\d+)\/fired$/);
  if (m) {
    const f = flies.find(x => x.id === +m[1]);
    if (!f) return json.call(null, { error: "no such fly" });
    const stride = Math.max(1, Math.min(64, Number(u.searchParams.get("stride") || 4)));
    const n = Math.ceil(NODES / stride), bytes = new Uint8Array(Math.ceil(n / 8));
    const rate = f.mode ? 0.05 : 0.03;
    for (let k = 0; k < n; k++) {
      // structured so the raster has visible bands: sensory band busy, motor band busy when moving
      const frac = k / n;
      const pr = frac < 0.1 ? rate * 3 : frac > 0.9 ? rate * (f.mode || f.speed > 0.1 ? 4 : 0.5) : rate;
      if (Math.random() < pr) bytes[k >> 3] |= 1 << (k & 7);
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-cache" });
    return res.end(bytes);
  }
  m = p.match(/^\/api\/fly\/(\d+)\.svg$/);
  if (m) {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="#F3EEE3"/><text x="12" y="58" font-family="serif" font-size="22">Instar fly #${m[1]} (mock portrait)</text></svg>`);
  }
  if (p.startsWith("/api/")) return json({ error: "mock: no such route" });
  // static
  let file = path.join(SITE, p === "/" ? "index.html" : p.replace(/^\//, ""));
  if (p.startsWith("/data/")) file = path.join(SITE, "..", p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`mock world on http://127.0.0.1:${PORT}/`));
