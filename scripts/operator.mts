// The operator's hand on the world: every program instruction the world
// process does not send on its own. Run from Windows:
//
//   npx tsx scripts/operator.mts <command> [args] [--yes] [--allow-fresh]
//
//   status                                   the World, balances, heartbeat age, and the
//                                            live process's /api/health if it answers
//   heartbeat                                refresh last_operator_action
//   fund <lamports> <pool_bps>               feed the world from the operator key
//   fund-fee-keypair <lamports>              SOL for claim fees, operator -> INSTAR_FEE_KEYPAIR
//   withdraw-treasury <to> <m> <p>           m, p: lamports | all | 0
//   set-recovery <pubkey>                    both refuse a destination that has never signed
//                                            a transaction unless --allow-fresh is given
//   transfer-operator <pubkey>               names the key that may accept
//   accept-operator [keypair.json]           signed by the pending key (default: the
//                                            operator keypair, i.e. the new operator's)
//   re-offer <id> <lamports>                 open_offer on a larva sent back to the dish
//   force-settle-cull <id>                   after CULL_TIMEOUT; anyone may
//   begin-wind-down                          ONE-WAY; the operator, or anyone after
//                                            ABANDONED_AFTER
//   sweep-to-recovery                        wind-down: treasuries to recovery
//   escheat                                  wind-down + ESCHEAT_AFTER: everything to recovery
//   rotate-master-key <master.key>           re-seal DATA_DIR/accounts.json under the key in
//                                            that file (npm run keys:new); world stopped
//
// Every command that sends a transaction prints what it is about to do and
// stops there unless --yes is given; afterwards it re-reads the World and
// prints every field that changed. Env: INSTAR_CLUSTER (default localnet),
// INSTAR_RPC, INSTAR_PROGRAM_ID, INSTAR_OPERATOR_KEYPAIR (default
// .keys/operator.json), INSTAR_URL (the world process, default
// http://localhost:8787, for status), DATA_DIR and INSTAR_MASTER_KEY and PORT
// (for rotate-master-key, as the world reads them).
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Chain, PUBLIC_RPC, STATUS, STATUS_NAME, formatSol, loadKeypair, type Cluster, type WorldView } from "../services/chain/solana.mts";
import { deriveMasterKey, resealAccounts } from "../services/world/accounts.mts";
import { lockHolder } from "../services/world/journal.mts";

const ABANDONED_AFTER_S = 90 * 86_400;
const ESCHEAT_AFTER_S = 180 * 86_400;
/// /api/health awaits its own RPC probe for up to 5 s before answering
const HEALTH_TIMEOUT_MS = 8000;
/// what each cluster's RPC answers to getGenesisHash; localnet is whatever was started
const GENESIS: Partial<Record<Cluster, string>> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const FLAGS = ["--yes", "--allow-fresh"];
const unknownFlags = argv.filter(a => a.startsWith("--") && !FLAGS.includes(a));
const yes = argv.includes("--yes");
const allowFresh = argv.includes("--allow-fresh");
const [command, ...args] = argv.filter(a => !a.startsWith("--"));
const cluster = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
if (!(cluster in PUBLIC_RPC)) throw new Error(`INSTAR_CLUSTER must be one of ${Object.keys(PUBLIC_RPC).join(", ")}`);
const operatorPath = path.resolve(root, process.env.INSTAR_OPERATOR_KEYPAIR ?? ".keys/operator.json");
const worldUrl = (process.env.INSTAR_URL ?? "http://localhost:8787").replace(/\/$/, "");

const usage = () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(src.split("\n").slice(3, 27).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
};

const age = (s: number) => {
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
const when = (unix: number) => unix ? new Date(unix * 1000).toISOString() : "never";
const sol = (l: bigint) => `${l} lamports (${formatSol(l)} SOL)`;

const pubkey = (s: string | undefined, what: string) => {
  try { return new PublicKey(String(s)); } catch { throw new Error(`${what}: not a Solana address (${s})`); }
};
const lamports = (s: string | undefined, what: string) => {
  if (!/^\d+$/.test(s ?? "")) throw new Error(`${what}: whole lamports, not ${JSON.stringify(s)}`);
  return BigInt(s!);
};
const larvaId = (s: string | undefined) => {
  const id = Number(s);
  if (!Number.isInteger(id) || id < 0) throw new Error(`id: a larva number, not ${JSON.stringify(s)}`);
  return id;
};

/// Everything the World says, in the order PROGRAM.md lists it.
function worldRows(w: WorldView): [string, string][] {
  return [
    ["operator", w.operator.toBase58()], ["pending operator", w.pendingOperator.toBase58()],
    ["recovery", w.recovery.toBase58()], ["collection", w.collection.toBase58()],
    ["next id", String(w.nextId)], ["alive", String(w.totalAlive)],
    ["last epoch", `${w.lastEpoch} @tick ${w.lastEpochTick} hash ${w.lastStateHash.slice(-16)}`],
    ["metabolism", sol(w.metabolism)], ["pool", sol(w.pool)],
    ["vaults (total)", sol(w.totalVaults)], ["credit (total)", sol(w.totalCredit)],
    ["last operator action", when(w.lastOperatorAction)],
    ["wind-down", w.windDown ? `since ${when(w.windDownAt)}` : "no"],
    ["lamports", sol(w.lamports)],
  ];
}

function printDiff(before: WorldView, after: WorldView) {
  const a = worldRows(before);
  const changed = worldRows(after).map(([k, to], i) => [k, a[i][1], to] as const).filter(([, from, to]) => from !== to);
  if (!changed.length) { console.log("world unchanged"); return; }
  console.log("world after:");
  for (const [k, from, to] of changed) console.log(`  ${k.padEnd(22)} ${from}  ->  ${to}`);
}

/// Say what is about to happen; send only with --yes.
async function act(chain: Chain, plan: string[], send: () => Promise<string>) {
  console.log(`about to send on ${cluster} (${chain.rpcUrl}):`);
  for (const p of plan) console.log(`  ${p}`);
  // exitCode rather than exit(): on Windows, exit() under an RPC socket
  // still closing trips a libuv assertion
  if (!yes) { console.log("\nnothing sent — add --yes to send it"); process.exitCode = 2; return; }
  // "on localnet (https://mainnet...)" must never be a line that sends
  const expect = GENESIS[cluster];
  if (expect) {
    const genesis = await chain.connection.getGenesisHash();
    if (genesis !== expect) throw new Error(`INSTAR_RPC ${chain.rpcUrl} is not a ${cluster} endpoint (genesis ${genesis}, expected ${expect}) — nothing sent`);
  }
  const before = await chain.world();
  const sig = await send();
  console.log(`sent: ${sig}\n      ${chain.explorerTx(sig)}`);
  printDiff(before, await chain.world());
}

async function status(chain: Chain, operator: Keypair) {
  console.log(`cluster:   ${cluster} (${chain.rpcUrl})`);
  console.log(`program:   ${chain.programId.toBase58()}`);
  console.log(`world:     ${chain.worldPda.toBase58()}`);
  console.log(`signer:    ${operator.publicKey.toBase58()} (${formatSol(await chain.balance(operator.publicKey))} SOL)`);
  if (!(await chain.worldExists())) { console.log("world:     not initialised (npm run world:init)"); return; }
  const w = await chain.world();
  const now = Math.floor(Date.now() / 1000);
  console.log("");
  for (const [k, v] of worldRows(w)) console.log(`${(k + ":").padEnd(22)} ${v}`);
  console.log(`${"operator balance:".padEnd(22)} ${formatSol(await chain.balance(w.operator))} SOL${w.operator.equals(operator.publicKey) ? "" : "  (NOT the signer above)"}`);
  console.log(`${"recovery balance:".padEnd(22)} ${formatSol(await chain.balance(w.recovery))} SOL`);
  const silence = now - w.lastOperatorAction;
  console.log(`${"heartbeat age:".padEnd(22)} ${age(silence)}${silence > ABANDONED_AFTER_S ? "  ABANDONED: anyone may begin_wind_down" : ` (abandonment at ${when(w.lastOperatorAction + ABANDONED_AFTER_S)})`}`);
  if (w.windDown) {
    const at = w.windDownAt + ESCHEAT_AFTER_S;
    console.log(`${"escheat:".padEnd(22)} ${now > at ? "open now" : `opens ${when(at)} (in ${age(at - now)})`}`);
  }
  console.log("");
  try {
    const res = await fetch(`${worldUrl}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const h: any = await res.json();
    console.log(`process:   ${worldUrl} -> HTTP ${res.status}${h.phase === "replaying" ? `  REPLAYING tick ${h.tick} of ${h.target}` : h.ok ? "" : "  NOT OK"}`);
    if (h.phase === "replaying") return;
    console.log(`  tick ${h.tick}, ${h.ticksBehindWallClock} behind the clock; last epoch posted ${h.lastEpochPostedAgoS ?? "never"} s ago`);
    console.log(`  pending ops ${h.pendingOps}${h.stuckForS ? ` (head unmoved for ${h.stuckForS} s)` : ""}; settling ${h.settling}; journal ok ${h.journalOk}; operator ${h.operatorSol} SOL`);
    console.log(`  rpc ${h.rpc?.ok ? `ok, slot ${h.rpc.slot}` : `DOWN: ${h.rpc?.error}`}`);
  } catch (e: any) {
    console.log(`process:   ${worldUrl} not reachable (${String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e).slice(0, 80)})`);
  }
}

/// A larva as the CLI needs to describe it before acting on it.
async function describe(chain: Chain, id: number) {
  const c = await chain.creature(id);
  if (!c) throw new Error(`larva ${id} was never registered (next id is ${(await chain.world()).nextId})`);
  const where = c.keeper.equals(chain.worldPda) ? "the dish (World PDA)" : c.keeper.equals(PublicKey.default) ? "nobody (asset burned)" : c.keeper.toBase58();
  return { c, line: `larva ${id}: ${STATUS_NAME[c.status]}, gen ${c.generation}, asset ${c.asset.toBase58()}, held by ${where}, vault ${formatSol(c.vault)} SOL, price ${formatSol(c.salePrice)} SOL${c.pendingCull ? `, cull requested ${when(c.cullRequestedAt)}` : ""}` };
}

/// A destination for money that can never come back: a mistyped address is
/// usually still a valid one (no checksum), so it must look like a wallet
/// somebody holds — on the curve, system-owned, and it has signed at least
/// one transaction. --allow-fresh says the operator has checked it by hand.
async function requireLivedIn(chain: Chain, addr: PublicKey, what: string) {
  if (!PublicKey.isOnCurve(addr.toBytes())) throw new Error(`${what}: ${addr.toBase58()} is not on the curve — a PDA or program address, not a wallet; nothing sent there can ever be signed out`);
  const info = await chain.connection.getAccountInfo(addr, "confirmed");
  if (info && !info.owner.equals(SystemProgram.programId)) throw new Error(`${what}: ${addr.toBase58()} is owned by program ${info.owner.toBase58()}, not a wallet`);
  const sigs = await chain.connection.getSignaturesForAddress(addr, { limit: 1 }, "confirmed");
  if (sigs.length) return;
  const line = `${what}: ${addr.toBase58()} has never signed a transaction on ${cluster}${info ? "" : " and holds no SOL"}`;
  if (!allowFresh) throw new Error(`${line}\n  a one-character typo is usually still a valid address; send it a dust transfer and sign one from it first, or add --allow-fresh if you hold that key`);
  console.log(`WARNING  ${line} — --allow-fresh given`);
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

/// Off-chain, no signer: the custody file, re-sealed while the world sleeps.
/// The new key comes from a file (keys:new writes master.key, mode 0600),
/// never from the command line, which is shell history and `ps`; the bare
/// hex form is allowed on localnet only.
async function rotateMasterKey(source: string | undefined) {
  let newHex = "";
  if (source && fs.existsSync(path.resolve(root, source))) newHex = fs.readFileSync(path.resolve(root, source), "utf8").trim();
  else if (source && /^[0-9a-f]{64}$/i.test(source)) {
    if (cluster !== "localnet") throw new Error("rotate-master-key: on " + cluster + " the new key is read from a file (npm run keys:new writes master.key), not taken from the command line");
    newHex = source;
  } else throw new Error(`rotate-master-key: ${source ? `no such file ${source}` : "give the path of the new master.key"} (npm run keys:new -- <dir> makes one)`);
  if (!/^[0-9a-f]{64}$/i.test(newHex)) throw new Error(`rotate-master-key: ${source} does not hold 32 bytes as 64 hex characters`);
  const dataDir = path.resolve(root, process.env.DATA_DIR ?? "data/world");
  const port = Number(process.env.PORT ?? 8787);
  const held = lockHolder(dataDir);
  if (held?.alive) throw new Error(`${dataDir}/world.lock is held by pid ${held.pid}, alive since ${new Date(held.startedAt).toISOString()} — stop the world process first (it would write the old sealing back)`);
  if (await portOpen(port)) throw new Error(`something answers on :${port} — stop the world process first (it would write the old sealing back)`);
  const file = path.join(dataDir, "accounts.json");
  if (!fs.existsSync(file)) throw new Error(`no ${file}`);
  const current = process.env.INSTAR_MASTER_KEY ? Buffer.from(process.env.INSTAR_MASTER_KEY, "hex") : deriveMasterKey(loadKeypair(operatorPath).secretKey);
  if (current.length !== 32) throw new Error("INSTAR_MASTER_KEY must be 64 hex characters");
  const next = Buffer.from(newHex, "hex");
  if (current.equals(next)) throw new Error("that is the current key");
  console.log(`about to re-seal every custodial key in ${file}`);
  console.log(`  from ${process.env.INSTAR_MASTER_KEY ? "INSTAR_MASTER_KEY" : `the key derived from ${operatorPath}`} to the key in ${source}`);
  console.log(`  accounts.json.bak is rewritten under the new key too; the world must then start with INSTAR_MASTER_KEY=<new>`);
  if (!yes) { console.log("\nnothing written — add --yes to do it"); process.exitCode = 2; return; }
  const n = resealAccounts(dataDir, current, next);
  console.log(`re-sealed ${n} account(s); start the world with INSTAR_MASTER_KEY set to the new key`);
}

async function main() {
  if (unknownFlags.length) throw new Error(`unknown flag(s): ${unknownFlags.join(" ")} (known: ${FLAGS.join(" ")})`);
  if (!command || command === "help") { usage(); process.exitCode = command ? 0 : 2; return; }
  if (command === "rotate-master-key") return rotateMasterKey(args[0]);

  const operator = loadKeypair(command === "accept-operator" && args[0] ? path.resolve(root, args[0]) : operatorPath);
  const chain = new Chain({ cluster, rpc: process.env.INSTAR_RPC, programId: process.env.INSTAR_PROGRAM_ID, operator });
  if (command === "status") return status(chain, operator);
  if (!(await chain.worldExists())) throw new Error(`no World at ${chain.worldPda.toBase58()} on ${cluster} — npm run world:init`);
  const w = await chain.world();
  const me = operator.publicKey;
  const asOperator = () => {
    if (!w.operator.equals(me)) throw new Error(`${me.toBase58()} is not the operator (${w.operator.toBase58()} is)`);
  };

  switch (command) {
    case "heartbeat": {
      asOperator();
      return act(chain, [`heartbeat: last operator action was ${when(w.lastOperatorAction)} (${age(Math.floor(Date.now() / 1000) - w.lastOperatorAction)} ago)`], () => chain.heartbeat());
    }
    case "fund": {
      const amount = lamports(args[0], "lamports"), bps = Number(args[1]);
      if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`pool_bps: 0..10000, not ${JSON.stringify(args[1])}`);
      if (amount === 0n) throw new Error("fund: nothing to send");
      const toPool = (amount * BigInt(bps)) / 10_000n;
      return act(chain, [
        `fund ${sol(amount)} from ${me.toBase58()} (${formatSol(await chain.balance(me))} SOL)`,
        `  ${sol(toPool)} to the pool, ${sol(amount - toPool)} to metabolism`,
      ], () => chain.fund(amount, bps));
    }
    case "fund-fee-keypair": {
      // The fee keypair pays every creator-fee claim and nothing else funds
      // it (docs/COIN.md §1); this is how the operator seeds it.
      const amount = lamports(args[0], "lamports");
      if (amount === 0n) throw new Error("fund-fee-keypair: nothing to send");
      const feePath = path.resolve(root, process.env.INSTAR_FEE_KEYPAIR ?? ".keys/fee.json");
      if (!fs.existsSync(feePath)) throw new Error(`fee keypair not found: ${feePath} (INSTAR_FEE_KEYPAIR)`);
      const feeKey = loadKeypair(feePath).publicKey;
      const [mine, theirs] = await Promise.all([chain.balance(me), chain.balance(feeKey)]);
      await act(chain, [
        `transfer ${sol(amount)} from ${me.toBase58()} (${formatSol(mine)} SOL) to the fee keypair ${feeKey.toBase58()} (${formatSol(theirs)} SOL)`,
      ], () => chain.sendFromOperator(feeKey, amount));
      if (yes) console.log(`fee keypair now holds ${formatSol(await chain.balance(feeKey))} SOL`);
      return;
    }
    case "withdraw-treasury": {
      asOperator();
      const to = pubkey(args[0], "to");
      await requireLivedIn(chain, to, "to");
      const part = (s: string | undefined, name: string, held: bigint) => {
        if (s === "all") return "all" as const;
        const v = lamports(s, name);
        if (v > held) throw new Error(`${name}: ${v} asked, ${held} held`);
        return v;
      };
      const m = part(args[1], "metabolism", w.metabolism), p = part(args[2], "pool", w.pool);
      if (m === 0n && p === 0n) throw new Error("withdraw-treasury: both amounts are 0");
      const takeM = m === "all" ? w.metabolism : m, takeP = p === "all" ? w.pool : p;
      return act(chain, [
        `withdraw_treasury to ${to.toBase58()}`,
        `  metabolism: ${m === "all" ? "all, " : ""}${sol(takeM)} of ${sol(w.metabolism)}`,
        `  pool:       ${p === "all" ? "all, " : ""}${sol(takeP)} of ${sol(w.pool)}`,
        ...(takeM + takeP === 0n ? ["  the program will refuse this (NothingToWithdraw)"] : takeM > 0n ? [`  capacity follows metabolism: the world will keep ${sol(w.metabolism - takeM)} of it`] : []),
      ], () => chain.withdrawTreasury(to, m, p));
    }
    case "set-recovery": {
      asOperator();
      const r = pubkey(args[0], "pubkey");
      if (r.equals(me)) throw new Error("the recovery address must not be the operator: it is where the money goes when that key is lost");
      await requireLivedIn(chain, r, "recovery");
      return act(chain, [`set_recovery ${w.recovery.toBase58()} -> ${r.toBase58()}`, `  an abandoned world's money will go there; keep that key cold`], () => chain.setRecovery(r));
    }
    case "transfer-operator": {
      asOperator();
      const p = pubkey(args[0], "pubkey");
      return act(chain, [
        `transfer_operator: name ${p.toBase58()} as pending operator (currently ${w.pendingOperator.toBase58()})`,
        `  nothing changes until that key runs accept-operator; the world process keeps running on ${me.toBase58()}`,
      ], () => chain.transferOperator(p));
    }
    case "accept-operator": {
      if (!w.pendingOperator.equals(me)) throw new Error(`${me.toBase58()} is not the pending operator (${w.pendingOperator.toBase58()} is); run transfer-operator from ${w.operator.toBase58()} first`);
      return act(chain, [
        `accept_operator: ${me.toBase58()} becomes the operator, replacing ${w.operator.toBase58()}`,
        `  restart the world process with INSTAR_OPERATOR_KEYPAIR pointing at this key straight after, or every settlement it sends is NotOperator`,
      ], () => chain.acceptOperator(operator));
    }
    case "re-offer": {
      asOperator();
      const id = larvaId(args[0]), price = lamports(args[1], "lamports");
      if (price === 0n) throw new Error("re-offer: the price must be above zero");
      const { c, line } = await describe(chain, id);
      if (c.status !== STATUS.WILD && !(c.status === STATUS.OWNED && c.keeper.equals(chain.worldPda))) {
        throw new Error(`${line}\nonly a WILD larva, or an OWNED one whose asset is back in the World PDA's hands, can be offered`);
      }
      return act(chain, [line, `open_offer at ${sol(price)}${c.salePrice ? ` (clears the stale listing at ${formatSol(c.salePrice)} SOL)` : ""}`], () => chain.openOffer(id, price));
    }
    case "force-settle-cull": {
      const id = larvaId(args[0]);
      const { c, line } = await describe(chain, id);
      if (!c.pendingCull) throw new Error(`${line}\nno cull is pending; only the keeper can request one`);
      return act(chain, [line, `force_settle_cull: 85% of the vault to ${c.keeper.toBase58()}'s credit, 15% to metabolism, the asset burned`,
        `  the program refuses this before CULL_TIMEOUT (7 days from the request) with TooEarly`], () => chain.forceSettleCull(id));
    }
    case "begin-wind-down": {
      if (w.windDown) throw new Error(`the world has been winding down since ${when(w.windDownAt)}`);
      const silence = Math.floor(Date.now() / 1000) - w.lastOperatorAction;
      if (!w.operator.equals(me) && silence <= ABANDONED_AFTER_S) throw new Error(`${me.toBase58()} is not the operator and the world is not abandoned (heartbeat ${age(silence)} ago)`);
      return act(chain, [
        `begin_wind_down as ${w.operator.equals(me) ? "the operator" : "a stranger, the world being abandoned"} — ONE-WAY`,
        `  no birth, offer, sale, reward or funding lands after this; keepers may reclaim_vault, anyone may sweep_to_recovery,`,
        `  and ${ESCHEAT_AFTER_S / 86_400} days on anyone may escheat the rest to ${w.recovery.toBase58()}`,
      ], () => chain.beginWindDown(operator));
    }
    case "sweep-to-recovery": {
      if (!w.windDown) throw new Error("the world is not winding down; begin-wind-down first");
      return act(chain, [`sweep_to_recovery: metabolism ${sol(w.metabolism)} + pool ${sol(w.pool)} to ${w.recovery.toBase58()}, fee paid by ${me.toBase58()}`], () => chain.sweepToRecovery(operator));
    }
    case "escheat": {
      if (!w.windDown) throw new Error("the world is not winding down; begin-wind-down first");
      const opens = w.windDownAt + ESCHEAT_AFTER_S, now = Math.floor(Date.now() / 1000);
      return act(chain, [
        `escheat: every lamport above rent (${sol(w.lamports)} held; vaults ${formatSol(w.totalVaults)}, credit ${formatSol(w.totalCredit)} SOL) to ${w.recovery.toBase58()}`,
        `  the ledger is zeroed; keepers who have not reclaimed by then lose their claims`,
        `  ${now > opens ? "the timer has run" : `the program will refuse this (TooEarly) until ${when(opens)}, in ${age(opens - now)}`}`,
      ], () => chain.escheat(operator));
    }
    default:
      usage();
      throw new Error(`unknown command ${command}`);
  }
}

main().catch(e => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
