// A keeper's journey through the world's HTTP API, black-box, against a
// running world (localnet or devnet — it needs the airdrop route):
//
//   npx tsx scripts/journey.mts            (INSTAR_URL, default http://localhost:8787)
//
// Two users are created. The first signs in, is refused with a wrong pin, is
// airdropped, buys the first fly on offer, lists it, unlists it, transfers
// it to the second, and withdraws SOL to a sink address. A bad token is
// rejected. Every step is asserted on what the API returns, and every change
// of hands on what the fly's Core asset says on chain: the API is trusted
// for nothing it can be checked on.

import assert from "assert";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Chain, MPL_CORE } from "../services/chain/solana.mts";

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

/// The asset as the chain holds it; the API's `keeper` must agree with it.
async function assetOnChain(address: string) {
  const pk = new PublicKey(address);
  const info = await rpc.getAccountInfo(pk, "confirmed");
  const a = info && Chain.decodeAsset(pk, info);
  assert.ok(a, `asset ${address} is not on chain`);
  return a;
}

const collectionInfo = await rpc.getAccountInfo(new PublicKey(cfg.collection), "confirmed");
assert.ok(collectionInfo?.owner.equals(MPL_CORE), `config.collection ${cfg.collection} is not a Core account`);
const collectionMeta = (await get("/api/collection.json")).json;
assert.equal(collectionMeta.name, "Instar"); assert.equal(collectionMeta.symbol, "INSTAR");
// metadata URLs carry the world's PUBLIC_URL; fetch the file through the host this script reached
assert.ok(collectionMeta.image.startsWith(cfg.publicUrl), `collection image ${collectionMeta.image} is under ${cfg.publicUrl}`);
assert.ok((await fetch(BASE + collectionMeta.image.slice(cfg.publicUrl.length))).ok, "collection image served");
ok(`/api/config collection ${cfg.collection.slice(0, 8)} is a Core account; /api/collection.json served`);

const journal0 = (await get("/api/journal")).json;
assert.equal(journal0.name, "instar");
for (const k of ["cluster", "programId", "worldPda", "explorer", "seed", "era", "tick", "tickrate", "epoch", "epochInterval", "capacity", "bufferTicks",
  "entries", "epochs", "flies", "metabolism", "pool", "operator", "operatorBalance", "pendingOps", "settling", "txlog", "lineageNames", "stats"]) {
  assert.ok(k in journal0, `/api/journal missing ${k}`);
}
assert.ok(Number.isInteger(journal0.bufferTicks) && journal0.bufferTicks > 0, `bufferTicks ${journal0.bufferTicks}`);
ok(`/api/journal complete — tick ${journal0.tick}, ${journal0.flies.length} flies on chain, pop ${journal0.stats.pop}, bufferTicks ${journal0.bufferTicks}`);
ok(`/api/config world layout — lastStateHash at byte ${cfg.world.lastStateHash.offset}`);

// ---- auth --------------------------------------------------------------------
const suffix = Math.random().toString(36).slice(2, 8);
const u1 = `journey-${suffix}`, u2 = `keeper-${suffix}`, pin = "hunter22";
const noMatch = /no account matches/;
// /api/auth allows five attempts per minute per address (anti-brute-force);
// the auth section spends exactly five, so the third keeper signs up after
// the window has passed.
const authWindowOpens = Date.now() + 61_000;
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
// localnet airdrops 1 SOL; devnet may fall back to a 0.2 SOL operator top-up
assert.ok(BigInt(me.balance) >= BigInt(LAMPORTS_PER_SOL) / 6n, `balance ${me.balance}`);
ok(`airdrop -> balance ${me.balance} lamports`);

// ---- buy the first fly on offer --------------------------------------------
const deadline = Date.now() + OFFER_WAIT_MS;
let offered: any = null;
while (!offered && Date.now() < deadline) {
  const j = (await get("/api/journal")).json;
  offered = j.flies.find((l: any) => l.status === 1) ?? null;
  if (!offered) await new Promise(r => setTimeout(r, 3000));
}
assert.ok(offered, `no fly came up for sale within ${OFFER_WAIT_MS / 1000}s (pendingOps ${(await get("/api/journal")).json.pendingOps})`);
const id = offered.id;
const stale = (BigInt(offered.salePrice) + 1n).toString();
await expectError(post("/api/buy", { id, lamports: stale }, a1.token), 409, /price changed/);
ok(`buy at a stale price (${stale}) refused with 409`);
const bought = (await post("/api/buy", { id, lamports: offered.salePrice }, a1.token)).json;
assert.ok(bought.ok && bought.sig, JSON.stringify(bought));
me = (await post("/api/me", {}, a1.token)).json;
assert.ok(me.owned.includes(id), `owned ${JSON.stringify(me.owned)}`);
ok(`buy fly ${id} at ${offered.salePrice} lamports -> ${bought.sig.slice(0, 12)}; owned ${JSON.stringify(me.owned)}`);
await expectError(post("/api/buy", { id }, a1.token), 409, /not offered/);
ok("buying it again: refused");

let rec = (await get("/api/journal")).json.flies.find((l: any) => l.id === id);
assert.equal(rec.keeper, a1.wallet);
let asset = await assetOnChain(rec.asset);
assert.equal(asset.owner.toBase58(), a1.wallet, "the Core asset's owner is the buyer's custodial wallet");
assert.equal(asset.collection?.toBase58(), cfg.collection);
assert.equal(asset.name, `Instar #${id}`);
// the URI is baked at birth from the world's PUBLIC_URL, which need not be
// the address this script reached the world by
assert.equal(asset.uri, `${cfg.publicUrl}/api/fly/${id}.json`);
ok(`asset ${rec.asset.slice(0, 8)} owned by ${u1}'s wallet on chain, in the collection, uri -> ${cfg.publicUrl}`);

const meta = (await get(`/api/fly/${id}.json`)).json;
assert.equal(meta.name, `Instar #${id}`); assert.equal(meta.symbol, "INSTAR");
assert.equal(meta.image, `${cfg.publicUrl}/api/fly/${id}.svg`);
assert.deepEqual(meta.properties, { files: [{ uri: meta.image, type: "image/svg+xml" }], category: "image" });
assert.ok(Array.isArray(meta.attributes) && meta.attributes.some((t: any) => t.trait_type === "Generation" && t.value === rec.generation));
const svg = await fetch(`${BASE}/api/fly/${id}.svg`);
assert.equal(svg.headers.get("content-type"), "image/svg+xml");
assert.ok((await svg.text()).startsWith("<svg"));
ok("fly metadata is Metaplex-shaped; portrait served");

// ---- list / unlist -----------------------------------------------------------
const askPrice = "20000000";
const listed = (await post("/api/list", { id, lamports: askPrice }, a1.token)).json;
assert.ok(listed.ok, JSON.stringify(listed));
rec = (await get("/api/journal")).json.flies.find((l: any) => l.id === id);
assert.equal(rec.salePrice, askPrice);
assert.ok(typeof rec.listedAt === "number" && rec.listedAt >= Math.floor(Date.now() / 1000) - 120, `listedAt ${rec.listedAt}`);
ok(`list at ${askPrice} lamports (listedAt ${rec.listedAt})`);
await expectError(post("/api/list", { id, lamports: "0" }, a1.token), 400, /above zero/);
const unlisted = (await post("/api/unlist", { id }, a1.token)).json;
assert.ok(unlisted.ok, JSON.stringify(unlisted));
rec = (await get("/api/journal")).json.flies.find((l: any) => l.id === id);
assert.equal(rec.salePrice, "0"); assert.equal(rec.listedAt, 0);
ok("unlist clears the listing and its timestamp");

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
asset = await assetOnChain(rec.asset);
assert.equal(asset.owner.toBase58(), a2.wallet, "the transfer moved the Core asset");
ok(`transfer fly ${id} -> ${u2}; asset owner on chain is ${u2}'s wallet`);

// ---- name the lineage ----------------------------------------------------------
// a1 no longer keeps the fly, so it cannot name the line; a2 can, unless an
// earlier run of this script already claimed the same line under another user.
await expectError(post("/api/name-lineage", { id, name: "mine now" }, a1.token), 403, /not yours/);
const named = await post("/api/name-lineage", { id, name: `line-${suffix}` }, a2.token);
if (named.status === 409) {
  assert.match(String(named.json.error), /already named/);
  ok(`lineage of fly ${id} was named by an earlier run; a non-keeper is still refused`);
} else {
  assert.ok(named.json.ok, JSON.stringify(named.json));
  assert.ok(Number.isInteger(named.json.lineage));
  const j0 = (await get("/api/journal")).json;
  assert.equal(j0.lineageNames[named.json.lineage]?.name, `line-${suffix}`);
  ok(`lineage ${named.json.lineage} named by its keeper; a non-keeper is refused`);
}

// ---- a native move leaves a stale listing behind -----------------------------
// The second keeper lists, then moves the NFT with a plain transfer (what a
// wallet does). The program is not told, so the listing stays on the record
// but is void: buy_listed checks the lister still owns the asset. The new
// owner unlists.
assert.ok((await post("/api/airdrop", {}, a2.token)).json.ok);
assert.ok((await post("/api/list", { id, lamports: askPrice }, a2.token)).json.ok);
const back = (await post("/api/transfer", { id, to: a1.wallet }, a2.token)).json;
assert.ok(back.ok, JSON.stringify(back));
asset = await assetOnChain(rec.asset);
assert.equal(asset.owner.toBase58(), a1.wallet);
rec = (await get("/api/journal")).json.flies.find((l: any) => l.id === id);
assert.equal(rec.keeper, a1.wallet); assert.equal(rec.salePrice, askPrice, "the listing is still on the record");
const u3 = `buyer-${suffix}`;
if (Date.now() < authWindowOpens) {
  console.log(`      waiting ${Math.ceil((authWindowOpens - Date.now()) / 1000)}s for the sign-in rate limit before creating ${u3}`);
  await new Promise(r => setTimeout(r, authWindowOpens - Date.now()));
}
const a3 = (await post("/api/auth", { user: u3, pin, create: true })).json;
assert.ok(a3.token, JSON.stringify(a3));
assert.ok((await post("/api/airdrop", {}, a3.token)).json.ok);
await expectError(post("/api/buylisted", { id }, a3.token), 400, /NotForSale/);
await expectError(post("/api/unlist", { id }, a2.token), 403, /not yours/);
assert.ok((await post("/api/unlist", { id }, a1.token)).json.ok);
rec = (await get("/api/journal")).json.flies.find((l: any) => l.id === id);
assert.equal(rec.salePrice, "0");
ok(`native move ${u2} -> ${u1} with a listing open: buy_listed by ${u3} refused (NotForSale); ${u1} unlists`);

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
console.log(`journey passed: ${step} checks; txlog for fly ${id}: ${mine.join(" -> ")}`);
