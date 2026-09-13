// Read-only audit of the world's recovery posture: who can get money out, when,
// and whether the ledger is backed by lamports. Exit code 1 if insolvent.
//   npx tsx scripts/check-recovery.mts
// Env: INSTAR_CLUSTER (default localnet), INSTAR_RPC, INSTAR_PROGRAM_ID.
// Timers printed are the deployed defaults (90 / 180 / 7 days); a short-timers
// test build uses seconds and is never deployed.
import { Keypair } from "@solana/web3.js";
import { Chain, PUBLIC_RPC, formatSol, type Cluster } from "../services/chain/solana.mts";

const ABANDONED_AFTER_S = 90 * 86_400;
const ESCHEAT_AFTER_S = 180 * 86_400;

const cluster = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
if (!(cluster in PUBLIC_RPC)) throw new Error(`INSTAR_CLUSTER must be one of ${Object.keys(PUBLIC_RPC).join(", ")}`);
// reads only; the signer is never used
const chain = new Chain({ cluster, rpc: process.env.INSTAR_RPC, programId: process.env.INSTAR_PROGRAM_ID, operator: Keypair.generate() });

const age = (s: number) => {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
const when = (unix: number) => new Date(unix * 1000).toISOString();

console.log(`cluster:   ${cluster} (${chain.rpcUrl})`);
console.log(`program:   ${chain.programId.toBase58()}`);
console.log(`world:     ${chain.worldPda.toBase58()}`);
if (!(await chain.worldExists())) {
  console.log("world:     not initialised (run npm run world:init)");
  process.exit(0);
}

const w = await chain.world();
const info = await chain.connection.getAccountInfo(chain.worldPda);
const rent = await chain.rentExempt(info?.data.length ?? 0);
const now = Math.floor(Date.now() / 1000);
const silence = now - w.lastOperatorAction;
const accounted = w.metabolism + w.pool + w.totalVaults + w.totalCredit;
const free = w.lamports - rent;
const solvent = free >= accounted;

console.log("");
console.log(`operator:          ${w.operator.toBase58()} (${formatSol(await chain.balance(w.operator))})`);
console.log(`pending operator:  ${w.pendingOperator.toBase58()}`);
console.log(`recovery:          ${w.recovery.toBase58()} (${formatSol(await chain.balance(w.recovery))})`);
console.log(`heartbeat:         ${when(w.lastOperatorAction)}, ${age(silence)} ago`);
if (w.windDown) {
  const escheatAt = w.windDownAt + ESCHEAT_AFTER_S;
  console.log(`wind-down:         begun ${when(w.windDownAt)}; keepers may reclaim_vault, anyone may sweep_to_recovery`);
  console.log(`escheat:           ${now > escheatAt ? "open now" : `opens ${when(escheatAt)} (in ${age(escheatAt - now)})`}`);
} else if (silence > ABANDONED_AFTER_S) {
  console.log(`wind-down:         not begun, but the world is ABANDONED: anyone may begin_wind_down`);
} else {
  console.log(`wind-down:         not begun; abandonment opens ${when(w.lastOperatorAction + ABANDONED_AFTER_S)} without a heartbeat`);
}
console.log("");
console.log(`larvae:            ${w.nextId} born, ${w.totalAlive} alive, epoch ${w.lastEpoch} at tick ${w.lastEpochTick}`);
console.log(`metabolism:        ${formatSol(w.metabolism)}`);
console.log(`pool:              ${formatSol(w.pool)}`);
console.log(`vaults (total):    ${formatSol(w.totalVaults)}`);
console.log(`credit (total):    ${formatSol(w.totalCredit)}`);
console.log(`accounted:         ${formatSol(accounted)}`);
console.log(`lamports:          ${formatSol(w.lamports)} (rent ${formatSol(rent)}, free ${formatSol(free)})`);
console.log(`solvent:           ${solvent ? "yes" : "NO"} (free - accounted = ${free - accounted} lamports)`);
if (!solvent) process.exit(1);
