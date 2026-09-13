// The operator's hand on the world: every program instruction the world
// process does not send on its own. Run from Windows:
//
//   npx tsx scripts/operator.mts <command> [args] [--yes] [--allow-fresh] [--to <addr>] [--nfts]
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
//   re-offer <id> <lamports>                 open_offer on a fly sent back to the cage
//   force-settle-cull <id>                   after CULL_TIMEOUT; anyone may
//   begin-wind-down                          ONE-WAY; the operator, or anyone after
//                                            ABANDONED_AFTER
//   sweep-to-recovery                        wind-down: treasuries to recovery
//   escheat                                  wind-down + ESCHEAT_AFTER: everything to recovery
//   recover-all --to <recovery>              the whole end of the world, resumable: wind-down,
//                                            sweep, escheat, close every record and credit,
//                                            close the World, drain the fee and operator keys,
//                                            print the program-close command. Does what the
//                                            chain allows NOW and dates the rest
//   sweep-custodial --to <recovery> [--nfts] after escheat only: every custodial wallet's SOL
//                                            (and with --nfts its flies) to recovery
//   rotate-master-key <master.key>           re-seal DATA_DIR/accounts.json under the key in
//                                            that file (npm run keys:new); world stopped
//
// Every command that sends a transaction prints what it is about to do and
// stops there unless --yes is given; afterwards it re-reads the World and
// prints every field that changed. Env: INSTAR_CLUSTER (default localnet),
// INSTAR_RPC, INSTAR_PROGRAM_ID, INSTAR_OPERATOR_KEYPAIR (default
// .keys/operator.json), INSTAR_URL (the world process, default
// http://localhost:8787, for status), INSTAR_FEE_KEYPAIR and INSTAR_COIN_MINT
// (recover-all's last fee claim and drain), DATA_DIR and INSTAR_MASTER_KEY
// and PORT (for rotate-master-key and sweep-custodial, as the world reads them).
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { CLOSE_BATCH, CU, Chain, PUBLIC_RPC, SIGNATURE_FEE, STATUS, STATUS_NAME, formatSol, loadKeypair, type Cluster, type WorldView } from "../services/chain/solana.mts";
import { FeeClaimer } from "../services/chain/fees.mts";
import { custodialKeypairs, deriveMasterKey, resealAccounts } from "../services/world/accounts.mts";
import { lockHolder } from "../services/world/journal.mts";

/// /api/health awaits its own RPC probe for up to 5 s before answering
const HEALTH_TIMEOUT_MS = 8000;
/// what each cluster's RPC answers to getGenesisHash; localnet is whatever was started
const GENESIS: Partial<Record<Cluster, string>> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const FLAGS = ["--yes", "--allow-fresh", "--nfts"];
const VALUE_FLAGS = ["--to"];
const values = new Map<string, string>();
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.includes(argv[i])) values.set(argv[i], argv[++i] ?? ""); else words.push(argv[i]);
}
const unknownFlags = words.filter(a => a.startsWith("--") && !FLAGS.includes(a));
const yes = words.includes("--yes");
const allowFresh = words.includes("--allow-fresh");
const nfts = words.includes("--nfts");
const [command, ...args] = words.filter(a => !a.startsWith("--"));
const cluster = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
if (!(cluster in PUBLIC_RPC)) throw new Error(`INSTAR_CLUSTER must be one of ${Object.keys(PUBLIC_RPC).join(", ")}`);
const operatorPath = path.resolve(root, process.env.INSTAR_OPERATOR_KEYPAIR ?? ".keys/operator.json");
const worldUrl = (process.env.INSTAR_URL ?? "http://localhost:8787").replace(/\/$/, "");
/// The program's timers are compile-time. A localnet validator preloads the
/// artifact on disk, whose marker says which build it is; elsewhere they are
/// the deployed values.
const FEATURES = path.join(root, "program", "target", "deploy", "instar.features");
const shortTimers = cluster === "localnet" && fs.existsSync(FEATURES) && fs.readFileSync(FEATURES, "utf8").trim() === "short-timers";
const ABANDONED_AFTER_S = shortTimers ? 4 : 90 * 86_400;
const ESCHEAT_AFTER_S = shortTimers ? 4 : 180 * 86_400;
const DAYS = (s: number) => s >= 86_400 ? `${s / 86_400} days` : `${s} s`;

const usage = () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(src.split("\n").slice(3, 31).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
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
const flyId = (s: string | undefined) => {
  const id = Number(s);
  if (!Number.isInteger(id) || id < 0) throw new Error(`id: a fly number, not ${JSON.stringify(s)}`);
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
    ["escheated", w.escheated ? `yes; ${w.closedRecords} of ${w.nextId} records closed, ${w.creditsOpen} credit(s) open` : "no"],
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

/// "on localnet (https://mainnet...)" must never be a line that sends.
async function assertEndpoint(chain: Chain) {
  const expect = GENESIS[cluster];
  if (!expect) return;
  const genesis = await chain.connection.getGenesisHash();
  if (genesis !== expect) throw new Error(`INSTAR_RPC ${chain.rpcShown} is not a ${cluster} endpoint (genesis ${genesis}, expected ${expect}) — nothing sent`);
}

/// Say what is about to happen; send only with --yes.
async function act(chain: Chain, plan: string[], send: () => Promise<string>) {
  console.log(`about to send on ${cluster} (${chain.rpcShown}):`);
  for (const p of plan) console.log(`  ${p}`);
  // exitCode rather than exit(): on Windows, exit() under an RPC socket
  // still closing trips a libuv assertion
  if (!yes) { console.log("\nnothing sent — add --yes to send it"); process.exitCode = 2; return; }
  await assertEndpoint(chain);
  const before = await chain.world();
  const sig = await send();
  console.log(`sent: ${sig}\n      ${chain.explorerTx(sig)}`);
  printDiff(before, await chain.world());
}

async function status(chain: Chain, operator: Keypair) {
  console.log(`cluster:   ${cluster} (${chain.rpcShown})`);
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

/// A fly as the CLI needs to describe it before acting on it.
async function describe(chain: Chain, id: number) {
  const c = await chain.creature(id);
  if (!c) throw new Error(`fly ${id} was never registered (next id is ${(await chain.world()).nextId})`);
  const where = c.keeper.equals(chain.worldPda) ? "the cage (World PDA)" : c.keeper.equals(PublicKey.default) ? "nobody (asset burned)" : c.keeper.toBase58();
  return { c, line: `fly ${id}: ${STATUS_NAME[c.status]}, gen ${c.generation}, asset ${c.asset.toBase58()}, held by ${where}, vault ${formatSol(c.vault)} SOL, price ${formatSol(c.salePrice)} SOL${c.pendingCull ? `, cull requested ${when(c.cullRequestedAt)}` : ""}` };
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
  const port = Number(process.env.PORT ?? 8787);
  const held = lockHolder(dataDir());
  if (held?.alive) throw new Error(`${dataDir()}/world.lock is held by pid ${held.pid}, alive since ${new Date(held.startedAt).toISOString()} — stop the world process first (it would write the old sealing back)`);
  if (await portOpen(port)) throw new Error(`something answers on :${port} — stop the world process first (it would write the old sealing back)`);
  const file = accountsFile();
  if (!fs.existsSync(file)) throw new Error(`no ${file}`);
  const current = masterKey();
  const next = Buffer.from(newHex, "hex");
  if (current.equals(next)) throw new Error("that is the current key");
  console.log(`about to re-seal every custodial key in ${file}`);
  console.log(`  from ${process.env.INSTAR_MASTER_KEY ? "INSTAR_MASTER_KEY" : `the key derived from ${operatorPath}`} to the key in ${source}`);
  console.log(`  accounts.json.bak is rewritten under the new key too; the world must then start with INSTAR_MASTER_KEY=<new>`);
  if (!yes) { console.log("\nnothing written — add --yes to do it"); process.exitCode = 2; return; }
  const n = resealAccounts(dataDir(), current, next);
  console.log(`re-sealed ${n} account(s); start the world with INSTAR_MASTER_KEY set to the new key`);
}

/// The custody key as the world reads it: INSTAR_MASTER_KEY, or on
/// localnet/devnet the one derived from the operator keypair.
function masterKey(): Buffer {
  const key = process.env.INSTAR_MASTER_KEY ? Buffer.from(process.env.INSTAR_MASTER_KEY, "hex") : deriveMasterKey(loadKeypair(operatorPath).secretKey);
  if (key.length !== 32) throw new Error("INSTAR_MASTER_KEY must be 64 hex characters");
  return key;
}
const dataDir = () => path.resolve(root, process.env.DATA_DIR ?? "data/world");
const accountsFile = () => path.join(dataDir(), "accounts.json");

type Holding = { user: string; keypair: Keypair | null; balance: bigint };

/// Every custodial wallet in DATA_DIR/accounts.json and the SOL it holds. A
/// record this master key cannot open has no keypair and no balance.
async function custodialHoldings(chain: Chain): Promise<Holding[]> {
  const list = custodialKeypairs(dataDir(), masterKey());
  const out: Holding[] = list.map(a => ({ ...a, balance: 0n }));
  const readable = out.filter(a => a.keypair);
  for (let i = 0; i < readable.length; i += 100) {
    const page = readable.slice(i, i + 100);
    const infos = await chain.connection.getMultipleAccountsInfo(page.map(a => a.keypair!.publicKey));
    page.forEach((a, j) => { a.balance = BigInt(infos[j]?.lamports ?? 0); });
  }
  return out;
}

/// The program-data account (an UpgradeableLoaderState::ProgramData: u32
/// tag, u64 slot, Option<Pubkey> upgrade authority, then the code). It holds
/// the program's rent and is what `solana program close` removes; the
/// program account itself stays behind, so its absence is what "closed" means.
async function programData(chain: Chain): Promise<{ lamports: bigint; authority: PublicKey | null } | null> {
  const info = await chain.connection.getAccountInfo(chain.programDataPda());
  if (!info) return null;
  const authority = info.data.length >= 45 && info.data[12] !== 0 ? new PublicKey(info.data.subarray(13, 45)) : null;
  return { lamports: BigInt(info.lamports), authority };
}

/// C:/x/y -> /mnt/c/x/y, for the WSL command recover-all prints.
const wslPath = (p: string) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);

/// The end of the world as one command, run as often as it takes. Every step
/// reads the chain and is done, possible now (sent with --yes), or waiting on
/// the step before it; a run stops printing "now" at the first step it does
/// not send, and dates the rest. What reaches `to` is counted per step and
/// in total. docs/RECOVERY.md is the narrative.
async function recoverAll(chain: Chain, operator: Keypair, to: PublicKey) {
  const me = operator.publicKey;
  if (to.equals(me)) throw new Error("--to is the operator key; recovery is where the money goes when that key is gone");
  await requireLivedIn(chain, to, "--to");
  const feePath = path.resolve(root, process.env.INSTAR_FEE_KEYPAIR ?? ".keys/fee.json");
  const fee = fs.existsSync(feePath) ? loadKeypair(feePath) : null;
  if (fee?.publicKey.equals(to)) throw new Error("--to is the fee keypair; it is drained here, not filled");
  const deployerPath = path.resolve(root, process.env.INSTAR_DEPLOYER_KEYPAIR ?? operatorPath);
  const now = () => Math.floor(Date.now() / 1000);
  const line = (n: string, title: string, text: string) => console.log(`${n.padStart(3)}  ${title.padEnd(18)} ${text}`);
  const note = (text: string) => console.log(`${"".padEnd(24)}${text}`);
  let recovered = 0n;
  /// Once a step is not sent (dry run, or the chain says not yet), the
  /// steps after it are described, not attempted.
  let pending = false;
  const run = async (n: string, title: string, what: string, send: () => Promise<void>): Promise<boolean> => {
    line(n, title, `now: ${what}`);
    if (!yes) { pending = true; return false; }
    const before = await chain.balance(to);
    await send();
    const got = (await chain.balance(to)) - before;
    recovered += got;
    note(`+${sol(got)} to recovery`);
    return true;
  };
  const done = async () => {
    console.log(`\n${yes ? "recovered this run" : "nothing sent (add --yes)"}: ${sol(recovered)}; recovery holds ${formatSol(await chain.balance(to))} SOL`);
    if (!yes) process.exitCode = 2;
  };

  console.log(`recover-all on ${cluster} (${chain.rpcShown}) -> ${to.toBase58()}`);
  console.log(`timers: abandonment ${DAYS(ABANDONED_AFTER_S)}, escheat ${DAYS(ESCHEAT_AFTER_S)} after wind-down${shortTimers ? " (short-timers artifact on disk)" : ""}\n`);
  if (yes) await assertEndpoint(chain);

  if (await chain.worldExists()) {
    let w = await chain.world();
    if (!w.recovery.equals(to)) throw new Error(`--to ${to.toBase58()} is not the World's recovery address ${w.recovery.toBase58()}; the program pays only that one, so pass it and every step lands in one place`);
    const rentWorld = await chain.rentExempt((await chain.connection.getAccountInfo(chain.worldPda))!.data.length);

    // 1
    if (w.windDown) line("1", "begin_wind_down", `done ${when(w.windDownAt)}`);
    else {
      const silence = now() - w.lastOperatorAction;
      const asOperator = w.operator.equals(me);
      if (!asOperator && silence <= ABANDONED_AFTER_S) {
        line("1", "begin_wind_down", `BLOCKED: ${me.toBase58()} is not the operator and the world is not abandoned (heartbeat ${age(silence)} ago; anyone may from ${when(w.lastOperatorAction + ABANDONED_AFTER_S)})`);
        return done();
      }
      await run("1", "begin_wind_down", `ONE-WAY, as ${asOperator ? "the operator" : "a stranger, the world being abandoned"}; no birth, sale, reward or funding lands after it`, async () => { await chain.beginWindDown(operator); });
      if (!pending) w = await chain.world();
    }

    // 2
    if (pending) line("2", "sweep_to_recovery", `then: metabolism ${formatSol(w.metabolism)} + pool ${formatSol(w.pool)} SOL`);
    else if (w.metabolism + w.pool === 0n) line("2", "sweep_to_recovery", w.escheated ? "done (escheat took the treasuries)" : "done: treasuries empty");
    else {
      await run("2", "sweep_to_recovery", `metabolism ${formatSol(w.metabolism)} + pool ${formatSol(w.pool)} SOL; vaults and credits untouched`, async () => { await chain.sweepToRecovery(operator); });
      if (!pending) w = await chain.world();
    }

    // 3
    if (w.escheated) line("3", "escheat", `done: ledger zero, ${sol(w.lamports - rentWorld)} above rent left behind`);
    else {
      const opens = w.windDown ? w.windDownAt + ESCHEAT_AFTER_S : 0;
      const owed = `vaults ${formatSol(w.totalVaults)} + credit ${formatSol(w.totalCredit)} SOL unclaimed`;
      if (pending) line("3", "escheat", `${DAYS(ESCHEAT_AFTER_S)} after wind-down: everything above rent (${owed}); keepers reclaim_vault and withdraw until then`);
      else if (now() <= opens) { line("3", "escheat", `opens ${when(opens)} (in ${age(opens - now())}): everything above rent (${owed}); keepers reclaim_vault and withdraw until then`); pending = true; }
      else {
        await run("3", "escheat", `${sol(w.lamports - rentWorld)} above rent (${owed}); keepers who did not reclaim lose their claims`, async () => { await chain.escheat(operator); });
        if (!pending) w = await chain.world();
      }
    }

    // 4: the rent
    if (pending) {
      line("4", "close records", `after escheat: ${w.nextId - w.closedRecords} Creature record(s), every Credit, then the World (${formatSol(rentWorld)} SOL of rent); sweep-custodial first`);
      line("5", "drain keys", "after close_world: the fee keypair (after a last claim) and the operator to recovery");
      line("6", "program close", "after close_world: solana program close, printed here");
      return done();
    }
    const open = await chain.openRecords({ from: 0, to: w.nextId });
    const credits = await chain.listCreditOwners();
    // custodial wallets: their SOL is swept by sweep-custodial, which needs
    // the World's `escheated` flag, so the World cannot close over them; and
    // their flies are only findable through the records, so say so now
    if (fs.existsSync(accountsFile())) {
      const held = await custodialHoldings(chain);
      const unreadable = held.filter(h => !h.keypair).length;
      const total = held.reduce((a, h) => a + h.balance, 0n);
      const wallets = new Set(held.filter(h => h.keypair).map(h => h.keypair!.publicKey.toBase58()));
      const kept = open.length ? (await chain.creatures({ from: 0, to: w.nextId })).filter(c => c.status !== STATUS.DEAD && wallets.has(c.keeper.toBase58())) : [];
      if (total > 0n || unreadable) {
        line("4", "close records", `REFUSED: ${accountsFile()} holds ${held.length} custodial wallet(s) with ${sol(total)}${unreadable ? ` and ${unreadable} this master key cannot open` : ""}`);
        note(`run sweep-custodial --to ${to.toBase58()}${kept.length ? ` --nfts (${kept.length} fly/flies are kept there)` : ""} first: it needs the World's escheated flag, and the World closes here`);
        return done();
      }
      note(`custodial wallets in ${accountsFile()}: ${held.length}, all empty${kept.length ? `; ${kept.length} fly/flies kept there stay collectibles unless sweep-custodial --nfts moves them before the records close` : ""}`);
    } else note(`no ${accountsFile()}: if this world had custodial wallets, sweep-custodial needs the World and must run before this`);

    if (!open.length) line("4", "close_record", `done: ${w.closedRecords} of ${w.nextId}`);
    else {
      const rent = open.reduce((a, r) => a + r.lamports, 0n);
      await run("4", "close_record", `${open.length} of ${w.nextId} open, ${sol(rent)} of rent, ${Math.ceil(open.length / CLOSE_BATCH)} transaction(s) of ${CLOSE_BATCH}`, async () => {
        for (let i = 0; i < open.length; i += CLOSE_BATCH) {
          const ids = open.slice(i, i + CLOSE_BATCH).map(r => r.id);
          note(`${ids[0]}..${ids[ids.length - 1]} (${ids.length}): ${await chain.closeRecords(ids, operator)}`);
        }
      });
    }
    if (!credits.length) line("", "close_credit", "done: no credit open");
    else if (!pending) {
      const rent = credits.reduce((a, c) => a + c.lamports, 0n);
      await run("", "close_credit", `${credits.length} open, ${sol(rent)} of rent`, async () => {
        for (let i = 0; i < credits.length; i += CLOSE_BATCH) {
          const page = credits.slice(i, i + CLOSE_BATCH);
          note(`${page.map(c => c.owner.toBase58().slice(0, 8)).join(" ")}: ${await chain.closeCredits(page.map(c => c.owner), operator)}`);
        }
      });
    }
    if (pending) {
      line("", "close_world", `then: the World's rent, ${sol(rentWorld)}${w.lamports > rentWorld ? ` plus ${sol(w.lamports - rentWorld)} that arrived after escheat` : ""}`);
      line("5", "drain keys", "after close_world");
      line("6", "program close", "after close_world");
      return done();
    }
    w = await chain.world();
    if (w.closedRecords !== w.nextId || w.creditsOpen !== 0) throw new Error(`the World counts ${w.closedRecords} of ${w.nextId} records closed and ${w.creditsOpen} credit(s) open after closing everything found; the program would refuse close_world (RecordsStillOpen) — run again`);
    await run("", "close_world", `the World's ${sol(w.lamports)}${w.lamports > rentWorld ? ` (rent plus ${sol(w.lamports - rentWorld)} that arrived after escheat)` : ", its rent"}; the collection account stays, ownerless`, async () => { note(`sent ${await chain.closeWorld(operator)}`); });
  } else {
    line("1-4", "world", "closed: wind-down, sweep, escheat, every record and credit, and the World itself are done");
  }

  // 5: the keys
  if (fee) {
    const mint = process.env.INSTAR_COIN_MINT;
    const balance = await chain.balance(fee.publicKey);
    if (balance === 0n && !mint) line("5", "drain fee keypair", `done: ${fee.publicKey.toBase58()} is empty`);
    else await run("5", "drain fee keypair", `${fee.publicKey.toBase58()} holds ${formatSol(balance)} SOL${mint ? "; a last claim of the coin's creator fees first" : ""}; to zero, the operator paying the fee`, async () => {
      if (mint) {
        const claimer = new FeeClaimer({ chain, mint: pubkey(mint, "INSTAR_COIN_MINT"), fee, log: l => note(l) });
        const results = await claimer.claim();
        if (!results.length) note("nothing to claim");
      }
      // the world's sweep leaves this key at exactly rent, which cannot pay
      // its own fee out; the operator pays and the key ends at zero
      const r = await chain.sendAll(fee, to, 0n, operator);
      note(r.signature ? `sent ${sol(r.lamports)}: ${r.signature}` : "already empty");
    });
  } else line("5", "drain fee keypair", `no fee keypair at ${feePath} (INSTAR_FEE_KEYPAIR)`);
  const program = await programData(chain);
  const authority = program?.authority ?? null;
  const closesProgram = !!authority && authority.equals(me);
  // a fee payer must stay rent-exempt once its fee is taken, so the key that
  // signs the program close keeps the rent floor plus that fee (one
  // signature, no priority fee: the CLI's default) plus the fee of the drain
  // that follows the close, which then takes it to zero
  const keep = closesProgram ? (await chain.rentExempt(0)) + SIGNATURE_FEE + chain.fee(CU.TRANSFER) : 0n;
  const mine = await chain.balance(me);
  if (mine <= keep) line("", "drain operator", `done: ${me.toBase58()} holds ${formatSol(mine)} SOL${keep ? ", the floor it keeps to sign the program close" : ""}`);
  else await run("", "drain operator", `${me.toBase58()} holds ${formatSol(mine)} SOL; ${keep ? `keeps ${sol(keep)}: the rent floor plus the fees of the program close it signs next and of the drain after it` : "to zero"}`, async () => {
    const r = await chain.sendAll(operator, to, keep);
    note(r.signature ? `sent ${sol(r.lamports)}: ${r.signature}` : "nothing above the fee to send");
  });

  // 6: the program
  if (!program) line("6", "program close", "done: the program is closed");
  else {
    line("6", "program close", `${sol(program.lamports)} of program rent; upgrade authority ${authority?.toBase58() ?? "none (immutable: this rent is gone for good)"}`);
    if (authority) {
      note("run from Windows, signed by that key:");
      note(`wsl -d Ubuntu-24.04 -u root -- bash ${wslPath(path.join(root, "scripts", "wsl-close-program.sh"))} ${cluster} ${to.toBase58()} "$INSTAR_RPC" ${wslPath(deployerPath)}`);
      note("(INSTAR_RPC is your keyed endpoint; it is deliberately not printed)");
      note("FINAL: the program id can never be deployed to again. Then run recover-all once more for the operator's last lamports.");
    }
  }
  return done();
}

/// After escheat: every custodial wallet's SOL (and, with --nfts, its
/// flies) to the recovery address, the operator paying every fee so each
/// wallet ends at exactly zero. The same 180-day rule the program applies to
/// vaults and credits, and disclosed the same way (site, ECONOMY.md).
async function sweepCustodial(chain: Chain, operator: Keypair, w: WorldView, to: PublicKey) {
  if (!w.escheated) {
    const opens = w.windDown ? w.windDownAt + ESCHEAT_AFTER_S : 0;
    throw new Error(`the chain does not say escheated: ${w.windDown ? `escheat opens ${when(opens)}; run it first` : "the world is not winding down"}. Until escheat what is in a custodial wallet is its keeper's`);
  }
  if (!to.equals(w.recovery)) throw new Error(`--to ${to.toBase58()} is not the World's recovery address ${w.recovery.toBase58()}, where the program sent the unclaimed funds; custodial balances go the same way`);
  if (!fs.existsSync(accountsFile())) throw new Error(`no ${accountsFile()} (DATA_DIR)`);
  const held = await custodialHoldings(chain);
  const wallets = new Map(held.filter(h => h.keypair).map(h => [h.keypair!.publicKey.toBase58(), h]));
  const kept = nfts ? (await chain.creatures({ from: 0, to: w.nextId })).filter(c => c.status !== STATUS.DEAD && wallets.has(c.keeper.toBase58())) : [];
  const fliesOf = (h: Holding) => kept.filter(c => h.keypair && c.keeper.equals(h.keypair.publicKey));
  console.log(`sweep-custodial on ${cluster} (${chain.rpcShown}): ${held.length} wallet(s) in ${accountsFile()} -> ${to.toBase58()}`);
  console.log(`fees paid by ${operator.publicKey.toBase58()} (${formatSol(await chain.balance(operator.publicKey))} SOL)\n`);
  let total = 0n;
  for (const h of held) {
    const who = h.user.padEnd(26);
    if (!h.keypair) { console.log(`  ${who} cannot be opened under this master key — skipped`); continue; }
    const mine = fliesOf(h);
    console.log(`  ${who} ${h.keypair.publicKey.toBase58()}  ${formatSol(h.balance)} SOL${mine.length ? `  flies ${mine.map(c => c.id).join(", ")}` : ""}`);
    total += h.balance;
  }
  console.log(`\n  total ${sol(total)}${nfts ? `, ${kept.length} fly/flies` : " (flies stay where they are; --nfts moves them too)"}`);
  if (!yes) { console.log("\nnothing sent — add --yes to send it"); process.exitCode = 2; return; }
  await assertEndpoint(chain);
  const before = await chain.balance(to);
  for (const h of held) {
    if (!h.keypair) continue;
    const keeper = chain.asKeeper(h.keypair);
    for (const c of fliesOf(h)) console.log(`  ${h.user}: fly ${c.id} -> recovery: ${await keeper.transferAsset(c.id, to, operator)}`);
    if (h.balance > 0n) {
      const r = await chain.sendAll(h.keypair, to, 0n, operator);
      console.log(`  ${h.user}: ${sol(r.lamports)} -> recovery: ${r.signature ?? "already empty"}`);
    }
  }
  console.log(`\nrecovered: ${sol((await chain.balance(to)) - before)}; recovery holds ${formatSol(await chain.balance(to))} SOL`);
}

async function main() {
  if (unknownFlags.length) throw new Error(`unknown flag(s): ${unknownFlags.join(" ")} (known: ${FLAGS.join(" ")})`);
  if (!command || command === "help") { usage(); process.exitCode = command ? 0 : 2; return; }
  if (command === "rotate-master-key") return rotateMasterKey(args[0]);

  const operator = loadKeypair(command === "accept-operator" && args[0] ? path.resolve(root, args[0]) : operatorPath);
  const chain = new Chain({ cluster, rpc: process.env.INSTAR_RPC, programId: process.env.INSTAR_PROGRAM_ID, operator });
  if (command === "status") return status(chain, operator);
  const toArg = () => {
    const v = values.get("--to");
    if (!v) throw new Error(`${command} needs --to <the recovery address>`);
    return pubkey(v, "--to");
  };
  if (command === "recover-all") return recoverAll(chain, operator, toArg());
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
      const id = flyId(args[0]), price = lamports(args[1], "lamports");
      if (price === 0n) throw new Error("re-offer: the price must be above zero");
      const { c, line } = await describe(chain, id);
      if (c.status !== STATUS.WILD && !(c.status === STATUS.OWNED && c.keeper.equals(chain.worldPda))) {
        throw new Error(`${line}\nonly a WILD fly, or an OWNED one whose asset is back in the World PDA's hands, can be offered`);
      }
      return act(chain, [line, `open_offer at ${sol(price)}${c.salePrice ? ` (clears the stale listing at ${formatSol(c.salePrice)} SOL)` : ""}`], () => chain.openOffer(id, price));
    }
    case "force-settle-cull": {
      const id = flyId(args[0]);
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
    case "sweep-custodial":
      return sweepCustodial(chain, operator, w, toArg());
    default:
      usage();
      throw new Error(`unknown command ${command}`);
  }
}

main().catch(e => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
