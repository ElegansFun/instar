// Verifies the program's money flows through the same Chain class the world
// uses, against a SCRATCH validator with the program deployed:
//
//   npm run localnet -- 8999          (second validator, separate ledger)
//   INSTAR_RPC=http://127.0.0.1:8999 npx tsx scripts/verify.mts
//
// Env: INSTAR_CLUSTER (default localnet), INSTAR_RPC, INSTAR_OPERATOR_KEYPAIR
// (default .keys/operator.json). The World is initialised here with this
// operator; it must not already hold larvae. The World PDA is a singleton per
// program, so running this beside the live world process would register
// births and epochs that world never produced and break its identity check —
// the script refuses rather than risk it. Keepers are throwaway keypairs
// funded by airdrop, so this only runs where airdrops work.
//
// Every flow asserts the exact lamport split from the contract and the
// solvency invariant afterwards:
//   world.lamports - rent >= metabolism + pool + sum(vault) + sum(credit)
// and, since every larva is a Metaplex Core asset, what the asset says:
// owner after every trade, the stale listing after a native transfer,
// freeze on cull, burn on death.

import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import { fileURLToPath } from "url";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { CLOSE_BATCH, Chain, MPL_CORE, ProgramError, STATUS, formatSol, loadKeypair, type Cluster } from "../services/chain/solana.mts";
import { hash32 } from "../services/world/engine.mts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLUSTER = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
const OPERATOR = process.env.INSTAR_OPERATOR_KEYPAIR ?? path.join(ROOT, ".keys", "operator.json");
const SOL = BigInt(LAMPORTS_PER_SOL);
const bps = (v: bigint, b: bigint) => (v * b) / 10_000n;

if (CLUSTER === "mainnet-beta") throw new Error("verify.mts spends throwaway SOL; not on mainnet");
if (!fs.existsSync(OPERATOR)) {
  fs.mkdirSync(path.dirname(OPERATOR), { recursive: true });
  fs.writeFileSync(OPERATOR, JSON.stringify([...Keypair.generate().secretKey]));
  console.log(`generated operator keypair at ${OPERATOR}`);
}
const operator = loadKeypair(OPERATOR);
const chain = new Chain({ cluster: CLUSTER, rpc: process.env.INSTAR_RPC, operator });
console.log(`cluster ${CLUSTER}  rpc ${chain.rpcUrl}  program ${chain.programId.toBase58()}`);

let step = 0;
const ok = (what: string) => console.log(`  ok ${String(++step).padStart(2)}  ${what}`);

async function ensureFunded(kp: Keypair, want: bigint) {
  const bal = await chain.balance(kp.publicKey);
  if (bal >= want) return;
  await chain.airdrop(kp.publicKey, want - bal + SOL);
}

/// The invariant every instruction that moves lamports must keep.
async function solvent(label: string) {
  const w = await chain.world();
  const rent = await chain.rentExempt((await chain.connection.getAccountInfo(chain.worldPda))!.data.length);
  const owed = w.metabolism + w.pool + w.totalVaults + w.totalCredit;
  assert.ok(w.lamports - rent >= owed, `${label}: insolvent — holds ${w.lamports - rent} above rent, owes ${owed}`);
  // total_vaults / total_credit are the program's running sums; check them
  // against the accounts themselves so a drifted counter cannot hide a hole
  const all = await chain.creatures({ from: 0, to: w.nextId });
  const vaults = all.reduce((a, c) => a + c.vault, 0n);
  assert.equal(vaults, w.totalVaults, `${label}: total_vaults ${w.totalVaults} != sum of vaults ${vaults}`);
  return w;
}

await ensureFunded(operator, 5n * SOL);
const COLLECTION_URI = "http://localhost:8787/api/collection.json";
if (!(await chain.worldExists())) {
  const sig = await chain.initWorld(Keypair.generate().publicKey, COLLECTION_URI);
  ok(`init_world ${sig.slice(0, 12)}`);
} else if ((await chain.world()).nextId > 0) {
  console.error(
    `the World at ${chain.rpcUrl} already holds larvae — it belongs to a running world process.\n` +
    `verify needs a scratch validator: npm run localnet -- 8999, then INSTAR_RPC=http://127.0.0.1:8999 npm run verify`
  );
  process.exit(2);
}
const rentWorld = await chain.rentExempt((await chain.connection.getAccountInfo(chain.worldPda))!.data.length);
const collection = (await chain.world()).collection;
const collectionInfo = await chain.connection.getAccountInfo(collection);
assert.ok(collectionInfo?.owner.equals(MPL_CORE), "the world's collection is a Core account");
console.log(`world ${chain.worldPda.toBase58()}  rent ${formatSol(rentWorld)} SOL  collection ${collection.toBase58()}`);

/// The asset behind a creature, which must exist while it lives.
const assetOf = async (id: number) => {
  const c = (await chain.creature(id))!;
  const a = await chain.asset(c.asset);
  assert.ok(a, `larva ${id}: asset ${c.asset.toBase58()} is missing`);
  return a;
};

const alice = Keypair.generate(), bob = Keypair.generate();
await ensureFunded(alice, 2n * SOL);
await ensureFunded(bob, 2n * SOL);
const A = chain.asKeeper(alice), B = chain.asKeeper(bob);
ok(`keepers funded: A ${alice.publicKey.toBase58().slice(0, 8)} B ${bob.publicKey.toBase58().slice(0, 8)}`);

// ---- birth + offer + buy ----------------------------------------------------
let w = await solvent("start");
const id = w.nextId;
const tick = 1000;
const hashA = hash32(0x1111222233334444n);
const uriA = `http://localhost:8787/api/larva/${id}.json`;
await chain.registerBirth(id, -1, 0, tick, hashA, uriA);
let c = (await chain.creature(id))!;
assert.equal(c.status, STATUS.WILD); assert.equal(c.parentId, -1); assert.equal(c.genomeHash.slice(-16), "1111222233334444");
assert.equal((await chain.world()).nextId, id + 1);
ok(`register_birth ${id} -> WILD, next_id ${id + 1}`);

let a = await assetOf(id);
assert.ok(a.owner.equals(chain.worldPda), "a wild larva's asset is owned by the World PDA");
assert.ok(c.keeper.equals(chain.worldPda), "creature view joins the asset owner");
assert.ok(a.collection?.equals(collection), "the asset is in the world's collection");
assert.equal(a.name, `Instar #${id}`); assert.equal(a.uri, uriA); assert.equal(a.frozen, false);
assert.deepEqual(a.attributes, { generation: "0", parent: "founder", birth_tick: String(tick), genome: c.genomeHash.slice(-16) });
ok(`asset ${a.address.toBase58().slice(0, 8)}: World-owned, in the collection, "${a.name}", attributes match`);

// The Creature PDA for a used id already exists, so Anchor's account init
// refuses before the handler can say WrongId; either way it cannot land.
await assert.rejects(chain.registerBirth(id, -1, 0, tick, hashA, uriA),
  (e: any) => e instanceof ProgramError && (e.name === "WrongId" || e.logs.some(l => /already in use/.test(l))));
ok("register_birth with a used id is refused");

const price = SOL / 100n;
await chain.openOffer(id, price);
c = (await chain.creature(id))!;
assert.equal(c.status, STATUS.OFFERED); assert.equal(c.salePrice, price);
ok(`open_offer ${id} at ${formatSol(price)} SOL`);

await assert.rejects(A.buy(id, price - 1n), (e: any) => e instanceof ProgramError && e.name === "WrongPrice");
ok("buy at the wrong price -> WrongPrice");

let before = await chain.world();
await A.buy(id, price);
w = await solvent("buy");
c = (await chain.creature(id))!;
assert.equal(c.status, STATUS.OWNED); assert.ok(c.keeper.equals(alice.publicKey)); assert.equal(c.salePrice, 0n);
assert.ok((await assetOf(id)).owner.equals(alice.publicKey), "buy moves the asset to the buyer");
assert.equal(c.vault, bps(price, 6000n));
assert.equal(w.metabolism - before.metabolism, bps(price, 1500n));
// no parent: the parent's 10% goes to the pool alongside the pool's 15%
assert.equal(w.pool - before.pool, bps(price, 1500n) + bps(price, 1000n));
assert.equal(w.lamports - before.lamports, price);
ok(`buy: 60% vault / 15% metabolism / 25% pool (no parent) — world +${formatSol(price)} SOL; asset owner is the buyer`);

// ---- a child of an OWNED parent: 10% to the parent's vault ------------------
const child = w.nextId;
await chain.registerBirth(child, id, 1, tick + 10, hash32(0x5555n), `http://localhost:8787/api/larva/${child}.json`);
const price2 = SOL / 50n;
await chain.openOffer(child, price2);
before = await chain.world();
const parentVaultBefore = (await chain.creature(id))!.vault;
await B.buy(child, price2);
w = await solvent("buy child");
assert.equal((await chain.creature(id))!.vault - parentVaultBefore, bps(price2, 1000n));
assert.equal((await chain.creature(child))!.vault, bps(price2, 6000n));
assert.equal(w.pool - before.pool, bps(price2, 1500n));
assert.equal(w.metabolism - before.metabolism, bps(price2, 1500n));
ok("buy with OWNED parent: 10% to the parent's vault");

// ---- list / unlist / resale --------------------------------------------------
// A listing carries the time it was made; buy_listed refuses one older than
// LISTING_MAX_AGE (30 days; 6 s under short-timers). The age refusal is only
// reachable on a short-timers artifact, so it runs when the local build's
// marker says so and the real-timer run asserts the timestamp alone.
const FEATURES = path.join(ROOT, "program", "target", "deploy", "instar.features");
const shortTimers = fs.existsSync(FEATURES) && fs.readFileSync(FEATURES, "utf8").trim() === "short-timers";
const ask = SOL / 20n;
const listedAtLo = Math.floor(Date.now() / 1000) - 120;
await A.list(id, ask);
c = (await chain.creature(id))!;
assert.equal(c.salePrice, ask); assert.ok(c.listedBy.equals(alice.publicKey));
assert.ok(c.listedAt >= listedAtLo && c.listedAt <= listedAtLo + 240, `listed_at ${c.listedAt} is not now`);
await A.unlist(id);
c = (await chain.creature(id))!;
assert.equal(c.salePrice, 0n); assert.ok(c.listedBy.equals(PublicKey.default)); assert.equal(c.listedAt, 0);
if (shortTimers) {
  await A.list(id, ask);
  await new Promise(r => setTimeout(r, 7000));
  await assert.rejects(B.buyListed(id, ask), (e: any) => e instanceof ProgramError && e.name === "NotForSale");
  ok("a listing older than LISTING_MAX_AGE (short-timers: 6 s) -> NotForSale");
}
await A.list(id, ask);
await assert.rejects(B.list(id, ask), (e: any) => e instanceof ProgramError && e.name === "NotOwner");
ok(`list / unlist / list; listed_at set and cleared; a stranger cannot list -> NotOwner${shortTimers ? "" : " (listing-age refusal needs a short-timers build)"}`);

before = await chain.world();
const vaultBefore = (await chain.creature(id))!.vault;
await B.buyListed(id, ask);
w = await solvent("buy_listed");
c = (await chain.creature(id))!;
assert.ok(c.keeper.equals(bob.publicKey)); assert.equal(c.salePrice, 0n); assert.equal(c.vault, vaultBefore);
assert.ok((await assetOf(id)).owner.equals(bob.publicKey), "buy_listed moves the asset to the buyer");
assert.equal(await chain.creditOf(alice.publicKey), bps(ask, 9000n));
assert.equal(w.metabolism - before.metabolism, bps(ask, 500n));
assert.equal(w.pool - before.pool, bps(ask, 500n));
ok("buy_listed: 90% seller credit / 5% / 5%, asset owner changes, vault travels");

// ---- native transfer ---------------------------------------------------------
// A keeper moves the NFT with a plain Core transfer, as any wallet would; the
// program is not told. The listing they left behind is void, not cleared:
// buy_listed checks the lister still owns the asset, and the new owner unlists.
await B.list(id, ask);
await B.transferAsset(id, alice.publicKey);
c = (await chain.creature(id))!;
assert.ok(c.keeper.equals(alice.publicKey)); assert.ok((await assetOf(id)).owner.equals(alice.publicKey));
assert.equal(c.salePrice, ask, "a native transfer leaves the listing on the record"); assert.ok(c.listedBy.equals(bob.publicKey));
await assert.rejects(B.buyListed(id, ask), (e: any) => e instanceof ProgramError && e.name === "NotForSale");
await A.unlist(id);
assert.equal((await chain.creature(id))!.salePrice, 0n);
ok("Core transfer: asset owner changes; the stale listing is void (buy_listed -> NotForSale); the new owner unlists");

// ---- epoch -------------------------------------------------------------------
// The world may already have posted epochs (verify runs beside a live world on
// localnet), so the next epoch continues from whatever is on chain.
w = await chain.world();
const epoch = w.lastEpoch + 1;
const epochTick = w.lastEpochTick + 2400;
await chain.postEpoch(epoch, epochTick, hash32(0xabcdefn));
w = await chain.world();
assert.equal(w.lastEpoch, epoch); assert.equal(w.lastEpochTick, epochTick); assert.equal(w.lastStateHash.slice(-6), "abcdef");
await assert.rejects(chain.postEpoch(epoch, epochTick + 2400, hash32(1n)), (e: any) => e instanceof ProgramError && e.name === "EpochNotMonotonic");
ok(`post_epoch ${epoch}; replaying it -> EpochNotMonotonic`);

// ---- rewards -----------------------------------------------------------------
before = await chain.world();
const r1 = before.pool / 4n, r2 = before.pool / 8n;
const v1 = (await chain.creature(id))!.vault, v2 = (await chain.creature(child))!.vault;
await chain.rewardMany([id, child], [r1, r2]);
w = await solvent("reward_many");
assert.equal(before.pool - w.pool, r1 + r2);
assert.equal((await chain.creature(id))!.vault - v1, r1);
assert.equal((await chain.creature(child))!.vault - v2, r2);
await assert.rejects(chain.rewardMany([id], [w.pool + 1n]), (e: any) => e instanceof ProgramError && e.name === "Insolvent");
ok("reward_many: pool -> vaults; more than the pool -> Insolvent");

// ---- death with an heir and a keeper -----------------------------------------
before = await chain.world();
const estate = (await chain.creature(id))!.vault;
const heirVault = (await chain.creature(child))!.vault;
const keeperCreditBefore = await chain.creditOf(alice.publicKey);
await chain.settleDeath(id, 1, tick + 3000, [child]);
w = await solvent("settle_death");
c = (await chain.creature(id))!;
assert.equal(c.status, STATUS.DEAD); assert.equal(c.vault, 0n); assert.equal(c.deathTick, tick + 3000);
assert.equal((await chain.creature(child))!.vault - heirVault, bps(estate, 4000n));
assert.equal(w.metabolism - before.metabolism, bps(estate, 3500n));
assert.equal(w.pool - before.pool, bps(estate, 1500n) + (estate - bps(estate, 4000n) - bps(estate, 3500n) - bps(estate, 1500n) - bps(estate, 1000n)));
assert.equal((await chain.creditOf(alice.publicKey)) - keeperCreditBefore, bps(estate, 1000n));
assert.equal(w.totalAlive, before.totalAlive - 1);
await assert.rejects(chain.settleDeath(id, 1, tick + 3001, []), (e: any) => e instanceof ProgramError && e.name === "WrongStatus");
assert.equal(await chain.asset(c.asset), null, "death burns the asset");
assert.ok(!c.asset.equals(PublicKey.default), "the burned asset stays on the record");
assert.ok(c.keeper.equals(PublicKey.default));
ok("settle_death: 40% heir / 35% metabolism / 15% pool / 10% keeper credit; asset burned; twice -> WrongStatus");

// ---- withdraw ----------------------------------------------------------------
const owed = await chain.creditOf(alice.publicKey);
const balBefore = await chain.balance(alice.publicKey);
await A.withdraw();
w = await solvent("withdraw");
assert.equal(await chain.creditOf(alice.publicKey), 0n);
const got = (await chain.balance(alice.publicKey)) - balBefore;
assert.ok(got >= owed - 10_000n && got <= owed, `withdraw moved ${got}, owed ${owed}`);
await assert.rejects(A.withdraw(), (e: any) => e instanceof ProgramError && e.name === "NothingToWithdraw");
ok(`withdraw: ${formatSol(owed)} SOL credit -> keeper; again -> NothingToWithdraw`);

// ---- cull: freeze, then settle at 85% to the keeper ------------------------------
await B.requestCull(child);
c = (await chain.creature(child))!;
assert.ok(c.pendingCull); assert.equal(c.salePrice, 0n);
a = await assetOf(child);
assert.equal(a.frozen, true, "a cull request freezes the asset");
await assert.rejects(B.transferAsset(child, alice.publicKey), (e: any) => e instanceof ProgramError);
assert.ok((await assetOf(child)).owner.equals(bob.publicKey), "a frozen asset cannot leave the dish");
await assert.rejects(B.list(child, ask), (e: any) => e instanceof ProgramError && e.name === "WrongStatus");
before = await chain.world();
const cullEstate = c.vault;
const bobCreditBefore = await chain.creditOf(bob.publicKey);
await chain.settleDeath(child, 6, tick + 4000, []);
w = await solvent("settle_death (cull)");
c = (await chain.creature(child))!;
assert.equal(c.status, STATUS.DEAD); assert.equal(c.vault, 0n);
assert.equal((await chain.creditOf(bob.publicKey)) - bobCreditBefore, bps(cullEstate, 8500n));
assert.equal(w.metabolism - before.metabolism, cullEstate - bps(cullEstate, 8500n));
assert.equal(await chain.asset(c.asset), null, "the cull settlement burns the asset");
ok("request_cull freezes the asset (transfer refused, list -> WrongStatus); settle_death(culled): 85% keeper credit, asset burned");

// ---- an unsold larva dies: no keeper, no credit account ----------------------------
const wild = w.nextId;
await chain.registerBirth(wild, -1, 0, tick + 20, hash32(0x7777n), `http://localhost:8787/api/larva/${wild}.json`);
const wildAsset = (await chain.creature(wild))!.asset;
await chain.settleDeath(wild, 2, tick + 4100, []);
w = await solvent("settle_death (wild)");
assert.equal((await chain.creature(wild))!.status, STATUS.DEAD);
assert.equal(await chain.asset(wildAsset), null);
ok("settle_death of a WILD larva: no keeper credit passed, asset burned");

// ---- the owner burns the asset natively, then the larva dies ------------------
// Core lets an owner burn an unfrozen asset from any wallet; the program is
// not told and the record stays OWNED. The death must still settle: no
// keeper (the share goes to metabolism), no credit account passed, nothing
// left to burn.
const burnt = w.nextId;
await chain.registerBirth(burnt, -1, 0, tick + 30, hash32(0x8888n), `http://localhost:8787/api/larva/${burnt}.json`);
await chain.openOffer(burnt, price);
await A.buy(burnt, price);
const burntAsset = (await chain.creature(burnt))!.asset;
await A.burnAsset(burnt);
assert.equal(await chain.asset(burntAsset), null, "the owner's native burn leaves no asset");
c = (await chain.creature(burnt))!;
assert.equal(c.status, STATUS.OWNED); assert.ok(c.keeper.equals(PublicKey.default), "a burned asset has no owner to read");
await assert.rejects(A.list(burnt, ask), (e: any) => e instanceof ProgramError && e.name === "WrongStatus");
before = await chain.world();
const burntEstate = c.vault;
const aliceCreditBefore = await chain.creditOf(alice.publicKey);
await chain.settleDeath(burnt, 3, tick + 4200, []);
w = await solvent("settle_death (natively burned)");
c = (await chain.creature(burnt))!;
assert.equal(c.status, STATUS.DEAD); assert.equal(c.vault, 0n);
assert.equal(w.metabolism - before.metabolism, burntEstate - bps(burntEstate, 1500n), "keeper and heir shares go to metabolism");
assert.equal(w.pool - before.pool, bps(burntEstate, 1500n));
assert.equal(await chain.creditOf(alice.publicKey), aliceCreditBefore, "no keeper credit for a burned asset");
assert.equal(w.totalAlive, before.totalAlive - 1);
ok("settle_death after the owner's native BurnV1: no keeper credit, 85% metabolism / 15% pool, record DEAD");

// ---- a larva sent back to the dish natively is re-offered ---------------------
// A keeper can transfer their asset to the World PDA from any wallet; the
// record stays OWNED with nobody able to sign for it. open_offer takes it
// back onto the market (the program checks the asset's owner is the World).
const donated = w.nextId;
await chain.registerBirth(donated, -1, 0, tick + 40, hash32(0x9999n), `http://localhost:8787/api/larva/${donated}.json`);
await chain.openOffer(donated, price);
await A.buy(donated, price);
await A.list(donated, ask);
await A.transferAsset(donated, chain.worldPda);
c = (await chain.creature(donated))!;
assert.equal(c.status, STATUS.OWNED); assert.ok(c.keeper.equals(chain.worldPda));
await assert.rejects(B.buy(donated, price), (e: any) => e instanceof ProgramError && e.name === "NotForSale");
await chain.openOffer(donated, price);
c = (await chain.creature(donated))!;
assert.equal(c.status, STATUS.OFFERED); assert.equal(c.salePrice, price);
assert.ok(c.listedBy.equals(PublicKey.default)); assert.equal(c.listedAt, 0);
await B.buy(donated, price);
c = (await chain.creature(donated))!;
assert.equal(c.status, STATUS.OWNED); assert.ok(c.keeper.equals(bob.publicKey));
await assert.rejects(chain.openOffer(donated, price), (e: any) => e instanceof ProgramError && e.name === "WrongStatus");
ok("a larva sent to the World PDA natively: buy -> NotForSale until open_offer re-offers it (listing cleared); then bought; re-offering a kept larva -> WrongStatus");

// ---- fund + sendSol ----------------------------------------------------------
before = await chain.world();
await chain.fund(SOL / 10n, 5000, bob);
w = await solvent("fund");
assert.equal(w.pool - before.pool, SOL / 20n); assert.equal(w.metabolism - before.metabolism, SOL / 20n);
const sink = Keypair.generate();
await B.sendSol(sink.publicKey, SOL / 10n);
assert.equal(await chain.balance(sink.publicKey), SOL / 10n);
await assert.rejects(B.sendSol(sink.publicKey, (await chain.balance(bob.publicKey)) - 1000n), /rent-exempt|fee/);
await B.sendSol(sink.publicKey, "max");
assert.equal(await chain.balance(bob.publicKey), 0n);
ok("fund splits by pool_bps; sendSol exact, rent guard, and max empties the wallet");

// ---- an id that was never born -----------------------------------------------
await assert.rejects(A.buy(w.nextId + 5, price), (e: any) => e instanceof ProgramError && e.name === "WrongId");
ok("buying an id that was never born -> WrongId");

// ---- the end of the world: the rent comes back too ----------------------------
// escheat is timer-gated (180 days; 4 s under short-timers), so the closing
// path runs only on a short-timers artifact, like the listing-age case. After
// it the World is gone; a new run of this script initialises it again.
if (shortTimers) {
  const recovery = w.recovery;
  const notEscheated = (e: any) => e instanceof ProgramError && e.name === "NotEscheated";
  await assert.rejects(chain.closeRecord(id), notEscheated);
  await chain.beginWindDown();
  await chain.sweepToRecovery();
  await assert.rejects(chain.closeRecord(id), notEscheated);
  await assert.rejects(chain.closeCredit(alice.publicKey), notEscheated);
  await assert.rejects(chain.closeWorld(), notEscheated);
  await new Promise(r => setTimeout(r, 5000));
  before = await chain.world();
  let recBefore = await chain.balance(recovery);
  await chain.escheat();
  w = await chain.world();
  assert.ok(w.escheated); assert.equal(w.totalVaults, 0n); assert.equal(w.totalCredit, 0n); assert.equal(w.metabolism, 0n); assert.equal(w.pool, 0n);
  assert.equal((await chain.balance(recovery)) - recBefore, before.lamports - rentWorld, "escheat pays exactly what was above rent");
  ok("wind-down, sweep, escheat (short-timers: 4 s): escheated set, ledger zero; close_record / close_credit / close_world before it -> NotEscheated");

  await assert.rejects(chain.closeWorld(), (e: any) => e instanceof ProgramError && e.name === "RecordsStillOpen");
  const open = await chain.openRecords({ from: 0, to: w.nextId });
  assert.equal(open.length, w.nextId, "every record is still readable");
  c = (await chain.creature(donated))!;
  assert.equal(c.status, STATUS.OWNED); assert.ok(c.keeper.equals(bob.publicKey), "a larva a keeper still holds closes like any other");
  const keptAsset = c.asset;
  const rentRecords = open.reduce((a, r) => a + r.lamports, 0n);
  recBefore = await chain.balance(recovery);
  for (let i = 0; i < open.length; i += CLOSE_BATCH) await chain.closeRecords(open.slice(i, i + CLOSE_BATCH).map(r => r.id));
  assert.equal((await chain.balance(recovery)) - recBefore, rentRecords, "recovery gains exactly the closed records' rent");
  assert.equal(await chain.creature(donated), null);
  assert.equal((await chain.openRecords({ from: 0, to: w.nextId })).length, 0);
  assert.ok((await chain.asset(keptAsset))?.owner.equals(bob.publicKey), "the kept larva's asset stays its owner's");
  ok(`close_record x ${open.length} (${Math.ceil(open.length / CLOSE_BATCH)} tx): ${formatSol(rentRecords)} SOL of rent to recovery; the OWNED larva's NFT stays with its keeper`);

  const credits = await chain.listCreditOwners();
  assert.ok(credits.some(x => x.owner.equals(alice.publicKey)) && credits.some(x => x.owner.equals(bob.publicKey)), "both keepers' credit accounts are listed");
  const rentCredits = credits.reduce((a, x) => a + x.lamports, 0n);
  recBefore = await chain.balance(recovery);
  await chain.closeCredits(credits.map(x => x.owner));
  assert.equal((await chain.balance(recovery)) - recBefore, rentCredits, "recovery gains exactly the closed credits' rent");
  assert.equal((await chain.listCreditOwners()).length, 0);
  w = await chain.world();
  assert.equal(w.closedRecords, w.nextId); assert.equal(w.creditsOpen, 0);
  ok(`close_credit x ${credits.length}: ${formatSol(rentCredits)} SOL of rent to recovery; World counts ${w.closedRecords}/${w.nextId} closed, 0 credits open`);

  recBefore = await chain.balance(recovery);
  await chain.closeWorld();
  assert.equal(await chain.worldExists(), false);
  assert.equal((await chain.balance(recovery)) - recBefore, w.lamports, "recovery gains the World's whole balance");
  assert.ok((await chain.connection.getAccountInfo(collection))?.owner.equals(MPL_CORE), "the collection account stays, a Core account with no authority left");
  ok(`close_world: ${formatSol(w.lamports)} SOL to recovery; the World is gone, the collection stays`);
}

console.log(`verify passed: ${step} checks, ${shortTimers ? `the world closed and ${formatSol(await chain.balance(w.recovery))} SOL sits at recovery` : `world holds ${formatSol(w.lamports)} SOL (metabolism ${formatSol(w.metabolism)}, pool ${formatSol(w.pool)})`}`);
