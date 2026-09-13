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

import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import { fileURLToPath } from "url";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Chain, ProgramError, STATUS, formatSol, loadKeypair, type Cluster } from "../services/chain/solana.mts";
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
if (!(await chain.worldExists())) {
  const sig = await chain.initWorld(Keypair.generate().publicKey);
  ok(`init_world ${sig.slice(0, 12)}`);
} else if ((await chain.world()).nextId > 0) {
  console.error(
    `the World at ${chain.rpcUrl} already holds larvae — it belongs to a running world process.\n` +
    `verify needs a scratch validator: npm run localnet -- 8999, then INSTAR_RPC=http://127.0.0.1:8999 npm run verify`
  );
  process.exit(2);
}
const rentWorld = await chain.rentExempt((await chain.connection.getAccountInfo(chain.worldPda))!.data.length);
console.log(`world ${chain.worldPda.toBase58()}  rent ${formatSol(rentWorld)} SOL`);

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
await chain.registerBirth(id, -1, 0, tick, hashA);
let c = (await chain.creature(id))!;
assert.equal(c.status, STATUS.WILD); assert.equal(c.parentId, -1); assert.equal(c.genomeHash.slice(-16), "1111222233334444");
assert.equal((await chain.world()).nextId, id + 1);
ok(`register_birth ${id} -> WILD, next_id ${id + 1}`);

// The Creature PDA for a used id already exists, so Anchor's account init
// refuses before the handler can say WrongId; either way it cannot land.
await assert.rejects(chain.registerBirth(id, -1, 0, tick, hashA),
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
assert.equal(c.vault, bps(price, 6000n));
assert.equal(w.metabolism - before.metabolism, bps(price, 1500n));
// no parent: the parent's 10% goes to the pool alongside the pool's 15%
assert.equal(w.pool - before.pool, bps(price, 1500n) + bps(price, 1000n));
assert.equal(w.lamports - before.lamports, price);
ok(`buy: 60% vault / 15% metabolism / 25% pool (no parent) — world +${formatSol(price)} SOL`);

// ---- a child of an OWNED parent: 10% to the parent's vault ------------------
const child = w.nextId;
await chain.registerBirth(child, id, 1, tick + 10, hash32(0x5555n));
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
const ask = SOL / 20n;
await A.list(id, ask);
assert.equal((await chain.creature(id))!.salePrice, ask);
await A.unlist(id);
assert.equal((await chain.creature(id))!.salePrice, 0n);
await A.list(id, ask);
await assert.rejects(B.list(id, ask), (e: any) => e instanceof ProgramError && e.name === "NotKeeper");
ok("list / unlist / list; a stranger cannot list -> NotKeeper");

before = await chain.world();
const vaultBefore = (await chain.creature(id))!.vault;
await B.buyListed(id, ask);
w = await solvent("buy_listed");
c = (await chain.creature(id))!;
assert.ok(c.keeper.equals(bob.publicKey)); assert.equal(c.salePrice, 0n); assert.equal(c.vault, vaultBefore);
assert.equal(await chain.creditOf(alice.publicKey), bps(ask, 9000n));
assert.equal(w.metabolism - before.metabolism, bps(ask, 500n));
assert.equal(w.pool - before.pool, bps(ask, 500n));
ok("buy_listed: 90% seller credit / 5% / 5%, keeper changes, vault travels");

// ---- transfer ----------------------------------------------------------------
await B.list(id, ask);
await B.transfer(id, alice.publicKey);
c = (await chain.creature(id))!;
assert.ok(c.keeper.equals(alice.publicKey)); assert.equal(c.salePrice, 0n, "transfer clears the listing");
ok("transfer: keeper changes, listing cleared");

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
ok("settle_death: 40% heir / 35% metabolism / 15% pool / 10% keeper credit; twice -> WrongStatus");

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

console.log(`verify passed: ${step} checks, world holds ${formatSol(w.lamports)} SOL (metabolism ${formatSol(w.metabolism)}, pool ${formatSol(w.pool)})`);
