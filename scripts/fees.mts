// $INSTAR's creator fees, by hand. Run from Windows:
//
//   npx tsx scripts/fees.mts <command> [--creator <pubkey>] [--dry-run] [--yes]
//
//   status         the bonding curve (complete? creator?), the canonical PumpSwap
//                  pool, both creator-fee vaults, the fee keypair's balance and
//                  its last claim on chain
//   claim          claim both vaults into the fee keypair, one transaction each.
//                  --dry-run builds the transactions, prints every account with
//                  its flags and the discriminator, and simulates them without
//                  sending (no signature needed, so --creator works here too)
//
// --creator <pubkey> reads another creator's vaults instead of the fee
// keypair's: read-only, for checking a coin you did not launch. Env:
// INSTAR_COIN_MINT (the coin), INSTAR_FEE_KEYPAIR (default .keys/fee.json),
// INSTAR_CLUSTER (default localnet), INSTAR_RPC.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Chain, PUBLIC_RPC, formatSol, loadKeypair, type Cluster } from "../services/chain/solana.mts";
import { FeeClaimer, LEG_SOURCE, PUMP, PUMP_AMM, specOf, type FeeStatus } from "../services/chain/fees.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
const dryRun = argv.includes("--dry-run");
const yes = argv.includes("--yes");
const creatorArg = flag("--creator");
const command = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--creator");
const cluster = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
if (!(cluster in PUBLIC_RPC)) throw new Error(`INSTAR_CLUSTER must be one of ${Object.keys(PUBLIC_RPC).join(", ")}`);

const usage = () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(src.split("\n").slice(2, 16).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
};
const pubkey = (s: string | undefined, what: string) => {
  try { return new PublicKey(String(s)); } catch { throw new Error(`${what}: not a Solana address (${s})`); }
};
const sol = (l: bigint) => `${l} lamports (${formatSol(l)} SOL)`;
const when = (unix: number | null | undefined) => unix ? new Date(unix * 1000).toISOString() : "unknown time";

if (!command || !["status", "claim"].includes(command)) { usage(); process.exit(command ? 1 : 0); }

const mint = pubkey(process.env.INSTAR_COIN_MINT, "INSTAR_COIN_MINT");
const feePath = path.resolve(root, process.env.INSTAR_FEE_KEYPAIR ?? ".keys/fee.json");
if (!fs.existsSync(feePath)) throw new Error(`fee keypair not found: ${feePath} (INSTAR_FEE_KEYPAIR)`);
const fee = loadKeypair(feePath);
const creator = creatorArg ? pubkey(creatorArg, "--creator") : undefined;
const chain = new Chain({ cluster, rpc: process.env.INSTAR_RPC, operator: fee });
const claimer = new FeeClaimer({ chain, mint, fee, creator, log: line => console.log(line) });

/// The last transaction of the creator that touched Pump or PumpSwap: claims
/// are the only reason the fee keypair ever meets those programs.
async function lastClaim(who: PublicKey): Promise<string> {
  const sigs = await chain.connection.getSignaturesForAddress(who, { limit: 25 }, "confirmed");
  for (const s of sigs) {
    const tx = await chain.connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx?.transaction.message.staticAccountKeys ?? [];
    if (keys.some(k => k.equals(PUMP) || k.equals(PUMP_AMM))) return `${s.signature} at ${when(s.blockTime)}${s.err ? " (FAILED)" : ""}`;
  }
  return sigs.length ? `none among the last ${sigs.length} transactions of ${who.toBase58()}` : `${who.toBase58()} has no transactions`;
}

function printStatus(s: FeeStatus) {
  console.log(`$INSTAR mint      ${s.mint.toBase58()}`);
  console.log(`creator           ${s.creator.toBase58()}${creator ? " (--creator, read-only)" : " (the fee keypair)"}`);
  if (!s.curve) console.log(`bonding curve     none at ${claimer.addresses.bondingCurve.toBase58()}`);
  else {
    console.log(`bonding curve     ${s.curve.address.toBase58()}`);
    console.log(`  complete        ${s.curve.complete ? "yes (graduated)" : "no (still trading on the curve)"}`);
    console.log(`  creator         ${s.curve.creator.toBase58()}${s.curve.creator.equals(s.creator) ? "" : "  <- NOT this creator"}`);
    console.log(`  quote           ${s.curve.quoteMint.toBase58()}`);
    if (s.curve.holderReward) console.log("  holder reward   yes: fees go to holders");
  }
  console.log(`curve vault       ${s.curveVault.address.toBase58()}: ${sol(s.curveVault.lamports)}, claimable ${sol(s.curveVault.claimable)} (rent floor ${s.vaultRent} lamports, read from the RPC)`);
  if (!s.pool) console.log(`pumpswap pool     none at ${claimer.addresses.pool.toBase58()} (not graduated to PumpSwap)`);
  else {
    console.log(`pumpswap pool     ${s.pool.address.toBase58()} (canonical)`);
    console.log(`  coin_creator    ${s.pool.coinCreator.toBase58()}${s.pool.coinCreator.equals(s.creator) ? "" : "  <- NOT this creator"}`);
  }
  console.log(`amm vault         ${s.ammVault.ata.toBase58()} (authority ${s.ammVault.authority.toBase58()}): ${s.ammVault.exists ? sol(s.ammVault.amount) + " wSOL" : "not created yet"}`);
  console.log(`creator wSOL      ${s.creatorWsol.ata.toBase58()}: ${s.creatorWsol.exists ? sol(s.creatorWsol.amount) + " (unclosed)" : "closed / never opened"}`);
  console.log(`sharing config    ${s.sharingConfig.exists ? `EXISTS at ${s.sharingConfig.address.toBase58()}` : "none"}`);
  console.log(`fee keypair       ${fee.publicKey.toBase58()}: ${sol(s.feeBalance)}`);
  for (const p of s.problems) console.log(`PROBLEM           ${p}`);
  for (const p of s.poolProblems) console.log(`PROBLEM (PumpSwap) ${p}`);
  if (!s.problems.length) console.log(`claimable         ${s.poolProblems.length ? "the bonding-curve vault only: the PumpSwap leg is blocked (see above)" : "yes: this creator's vaults, plain claims work"}`);
}

function printInstruction(ix: TransactionInstruction, n: number) {
  const spec = specOf(ix);
  const disc = ix.data.subarray(0, spec?.discriminator.length ?? Math.min(8, ix.data.length));
  console.log(`  ix ${n}: ${spec?.name ?? "?"} on ${ix.programId.toBase58()} discriminator [${[...disc].join(",")}] (${ix.data.length} data bytes)`);
  ix.keys.forEach((k, i) => {
    const flags = `${k.isWritable ? "w" : "-"}${k.isSigner ? "s" : "-"}`;
    console.log(`    ${String(i + 1).padStart(2)} ${flags} ${k.pubkey.toBase58().padEnd(44)} ${spec?.accounts[i]?.name ?? ""}`);
  });
}

/// With --creator the fee keypair is a stand-in that holds nothing, so the
/// simulation runs as the creator would in production: every key that is
/// the fee keypair (payer, ATA payer) becomes the creator. The program
/// accounts are untouched.
async function simulate(ixs: TransactionInstruction[], units: number) {
  const payer = creator ?? fee.publicKey;
  const asCreator = (k: PublicKey) => creator && k.equals(fee.publicKey) ? creator : k;
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs.map(ix => new TransactionInstruction({
    programId: ix.programId, data: ix.data, keys: ix.keys.map(k => ({ ...k, pubkey: asCreator(k.pubkey) })),
  }))];
  if (creator) console.log(`  simulating as ${payer.toBase58()} (the creator stands in for the fee keypair)`);
  const { blockhash } = await chain.connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: all }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  const res = await chain.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const v = res.value;
  console.log(`  simulate: ${v.err ? "FAILED " + JSON.stringify(v.err) : "ok"}, ${v.unitsConsumed ?? "?"} compute units of ${units}`);
  for (const l of v.logs ?? []) console.log(`    ${l}`);
}

const s = await claimer.status();
if (command === "status") {
  printStatus(s);
  console.log(`last claim        ${await lastClaim(s.creator)}`);
  process.exit(s.problems.length ? 1 : 0);
}

// claim
printStatus(s);
// with --creator the creator stands in as payer (see simulate), so its balance is what the plan can spend
const plan = claimer.plan(creator ? { ...s, feeBalance: s.creatorBalance } : s);
for (const why of plan.skipped) console.log(`skip              ${why}`);
if (plan.needs !== null) console.log(`FUND              fee keypair needs SOL for claims (has ${formatSol(s.feeBalance)}, needs about ${formatSol(plan.needs)}): npx tsx scripts/operator.mts fund-fee-keypair <lamports>`);
if (!plan.legs.length) { console.log("nothing to claim"); process.exit(0); }
for (const leg of plan.legs) {
  console.log(`\n${leg.leg} leg (${LEG_SOURCE[leg.leg]}): ${sol(leg.lamports)}, ${leg.ixs.length} instruction(s), ${leg.units} CU, payer ${fee.publicKey.toBase58()} (needs ${formatSol(leg.needs)} SOL on hand)`);
  leg.ixs.forEach((ix, i) => printInstruction(ix, i + 1));
  if (dryRun) await simulate(leg.ixs, leg.units);
}
if (dryRun) { console.log("\n--dry-run: nothing sent"); process.exit(0); }
if (s.problems.length) { console.log("\nrefusing to claim: see PROBLEM lines"); process.exit(1); }
if (!yes) { console.log("\nadd --yes to send"); process.exit(0); }
const results = await claimer.claim();
for (const r of results) console.log(`${r.leg}: fee keypair ${r.lamports >= 0n ? "+" : ""}${sol(r.lamports)} -> ${r.signature ? chain.explorerTx(r.signature) : "drained by another crank, no transaction of ours"}`);
if (!results.length) console.log("nothing to claim (vaults changed since the read, or the fee keypair cannot pay)");
