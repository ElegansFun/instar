// A keeper's journey through the world's HTTP API, black-box, against a
// running world (localnet or devnet — it needs the airdrop route):
//
//   npx tsx scripts/journey.mts            (INSTAR_URL, default http://localhost:8787)
//
// Two throwaway users: the first creates an account, is refused with the
// wrong pin, is airdropped, buys the first larva on offer, lists it, unlists
// it, transfers it to the second, and withdraws SOL to a sink address. A bad
// token is rejected. Every step is asserted on what the API returns.

import assert from "assert";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const BASE = (process.env.INSTAR_URL ?? "http://localhost:8787").replace(/\/$/, "");
const OFFER_WAIT_MS = 5 * 60_000;

let step = 0;
const ok = (what: string) => console.log(`  ok ${String(++step).padStart(2)}  ${what}`);

async function call(method: "GET" | "POST", route: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + route, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const post = (route: string, body: unknown, token?: string) => call("POST", route, body, token);
const get = (route: string) => call("GET", route);

async function expectError(p: Promise<{ status: number; json: any }>, status: number, re: RegExp) {
  const r = await p;
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.json)}`);
  assert.match(String(r.json.error), re);
}

const cfg = (await get("/api/config")).json;
assert.ok(cfg.programId && cfg.worldPda && cfg.cluster, "config");
assert.ok(Number.isInteger(cfg.world?.lastStateHash?.offset) && cfg.world.lastStateHash.size === 32, `config.world layout: ${JSON.stringify(cfg.world)}`);
assert.equal(cfg.world.account, cfg.worldPda);
if (cfg.cluster === "mainnet-beta") throw new Error("journey needs the airdrop route; not on mainnet");
const rpc = new Connection(process.env.INSTAR_RPC ?? cfg.rpc, "confirmed");
console.log(`world ${BASE}  cluster ${cfg.cluster}  program ${cfg.programId}`);

const journal0 = (await get("/api/journal")).json;
assert.equal(journal0.name, "instar");
for (const k of ["cluster", "programId", "worldPda", "explorer", "seed", "era", "tick", "tickrate", "epoch", "epochInterval", "capacity", "bufferTicks",
  "entries", "epochs", "larvae", "metabolism", "pool", "operator", "operatorBalance", "pendingOps", "settling", "txlog", "lineageNames", "stats"]) {
  assert.ok(k in journal0, `/api/journal missing ${k}`);
}
assert.ok(Number.isInteger(journal0.bufferTicks) && journal0.bufferTicks > 0, `bufferTicks ${journal0.bufferTicks}`);
ok(`/api/journal complete — tick ${journal0.tick}, ${journal0.larvae.length} larvae on chain, pop ${journal0.stats.pop}, bufferTicks ${journal0.bufferTicks}`);
ok(`/api/config world layout — lastStateHash at byte ${cfg.world.lastStateHash.offset}`);

// ---- auth --------------------------------------------------------------------
const suffix = Math.random().toString(36).slice(2, 8);
const u1 = `journey-${suffix}`, u2 = `keeper-${suffix}`, pin = "hunter22";
const noMatch = /no account matches/;
const unknown = await post("/api/auth", { user: u1, pin });
assert.equal(unknown.status, 400, JSON.stringify(unknown.json));
assert.match(String(unknown.json.error), noMatch);
ok("auth without create: refused (no squat-on-typo)");
const a1 = (await post("/api/auth", { user: u1, pin, create: true })).json;
assert.ok(a1.token && a1.wallet, JSON.stringify(a1));
ok(`auth create ${u1} -> wallet ${a1.wallet}`);
const wrong = await post("/api/auth", { user: u1, pin: "wrong-pin" });
assert.equal(wrong.status, 400);
assert.equal(wrong.json.error, unknown.json.error, "wrong pin and unknown name must read the same");
ok("wrong pin refused, with the same words as an unknown name");
const again = (await post("/api/auth", { user: u1, pin })).json;
assert.equal(again.wallet, a1.wallet);
ok("sign in again -> same wallet");
await expectError(post("/api/me", {}, "not-a-token"), 401, /not signed in/);
await expectError(post("/api/buy", { id: 0 }), 401, /not signed in/);
ok("bad token / no token rejected with 401");

// ---- funds -------------------------------------------------------------------
const drop = (await post("/api/airdrop", {}, a1.token)).json;
assert.ok(drop.ok, JSON.stringify(drop));
let me = (await post("/api/me", {}, a1.token)).json;
assert.ok(BigInt(me.balance) >= BigInt(LAMPORTS_PER_SOL) / 2n, `balance ${me.balance}`);
ok(`airdrop -> balance ${me.balance} lamports`);

// ---- buy the first larva on offer --------------------------------------------
const deadline = Date.now() + OFFER_WAIT_MS;
let offered: any = null;
while (!offered && Date.now() < deadline) {
  const j = (await get("/api/journal")).json;
  offered = j.larvae.find((l: any) => l.status === 1) ?? null;
  if (!offered) await new Promise(r => setTimeout(r, 3000));
}
assert.ok(offered, `no larva came up for sale within ${OFFER_WAIT_MS / 1000}s (pendingOps ${(await get("/api/journal")).json.pendingOps})`);
const id = offered.id;
const stale = (BigInt(offered.salePrice) + 1n).toString();
await expectError(post("/api/buy", { id, lamports: stale }, a1.token), 409, /price changed/);
ok(`buy at a stale price (${stale}) refused with 409`);
const bought = (await post("/api/buy", { id, lamports: offered.salePrice }, a1.token)).json;
assert.ok(bought.ok && bought.sig, JSON.stringify(bought));
me = (await post("/api/me", {}, a1.token)).json;
assert.ok(me.owned.includes(id), `owned ${JSON.stringify(me.owned)}`);
ok(`buy larva ${id} at ${offered.salePrice} lamports -> ${bought.sig.slice(0, 12)}; owned ${JSON.stringify(me.owned)}`);
await expectError(post("/api/buy", { id }, a1.token), 409, /not offered/);
ok("buying it again: refused");

const meta = (await get(`/api/larva/${id}.json`)).json;
assert.equal(meta.name, `Instar larva ${id}`);
const svg = await fetch(`${BASE}/api/larva/${id}.svg`);
assert.equal(svg.headers.get("content-type"), "image/svg+xml");
assert.ok((await svg.text()).startsWith("<svg"));
ok("larva metadata + portrait served");

// ---- list / unlist -----------------------------------------------------------
const askPrice = "20000000";
const listed = (await post("/api/list", { id, lamports: askPrice }, a1.token)).json;
assert.ok(listed.ok, JSON.stringify(listed));
let rec = (await get("/api/journal")).json.larvae.find((l: any) => l.id === id);
assert.equal(rec.salePrice, askPrice);
ok(`list at ${askPrice} lamports`);
await expectError(post("/api/list", { id, lamports: "0" }, a1.token), 400, /above zero/);
const unlisted = (await post("/api/unlist", { id }, a1.token)).json;
assert.ok(unlisted.ok, JSON.stringify(unlisted));
rec = (await get("/api/journal")).json.larvae.find((l: any) => l.id === id);
assert.equal(rec.salePrice, "0");
ok("unlist");

// ---- transfer to another user ------------------------------------------------
const a2 = (await post("/api/auth", { user: u2, pin, create: true })).json;
await expectError(post("/api/transfer", { id, to: a1.wallet }, a2.token), 403, /not yours/);
ok("another user cannot transfer it");
const moved = (await post("/api/transfer", { id, to: a2.wallet }, a1.token)).json;
assert.ok(moved.ok, JSON.stringify(moved));
const me2 = (await post("/api/me", {}, a2.token)).json;
assert.ok(me2.owned.includes(id));
me = (await post("/api/me", {}, a1.token)).json;
assert.ok(!me.owned.includes(id));
ok(`transfer larva ${id} -> ${u2}`);

// ---- name the lineage ----------------------------------------------------------
// a1 no longer keeps the larva, so it cannot name the line; a2 can, unless an
// earlier run of this script already claimed the same line under another user.
await expectError(post("/api/name-lineage", { id, name: "mine now" }, a1.token), 403, /not yours/);
const named = await post("/api/name-lineage", { id, name: `line-${suffix}` }, a2.token);
if (named.status === 409) {
  assert.match(String(named.json.error), /already named/);
  ok(`lineage of larva ${id} was named by an earlier run; a non-keeper is still refused`);
} else {
  assert.ok(named.json.ok, JSON.stringify(named.json));
  assert.ok(Number.isInteger(named.json.lineage));
  const j0 = (await get("/api/journal")).json;
  assert.equal(j0.lineageNames[named.json.lineage]?.name, `line-${suffix}`);
  ok(`lineage ${named.json.lineage} named by its keeper; a non-keeper is refused`);
}

// ---- withdraw to a sink --------------------------------------------------------
const sink = Keypair.generate().publicKey;
const amount = BigInt(LAMPORTS_PER_SOL) / 10n;
const out = (await post("/api/withdraw", { to: sink.toBase58(), lamports: amount.toString() }, a1.token)).json;
assert.ok(out.ok && out.sig, JSON.stringify(out));
assert.equal(BigInt(await rpc.getBalance(sink, "confirmed")), amount);
ok(`withdraw ${amount} lamports -> ${sink.toBase58().slice(0, 8)} (sink balance confirmed on chain)`);
await expectError(post("/api/withdraw", { to: "not-an-address" }, a1.token), 400, /Solana address/);
ok("withdraw to a malformed address refused");

const j = (await get("/api/journal")).json;
const mine = j.txlog.filter((t: any) => t.id === id).map((t: any) => t.kind);
console.log(`journey passed: ${step} checks; txlog for larva ${id}: ${mine.join(" -> ")}`);
