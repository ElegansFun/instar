// Everything that must be true before a public deployment, checked, not
// assumed. Run from Windows:
//   INSTAR_CLUSTER=mainnet-beta INSTAR_DEPLOYER_KEYPAIR=.keys/mainnet/operator.json \
//   INSTAR_RECOVERY=<pubkey> INSTAR_MASTER_KEY=<hex> [INSTAR_RPC=...] npx tsx scripts/preflight.mts
//
// Exits 0 only if every line is "ok". Lines marked "next" are steps that have
// not happened yet but are not wrong (program not deployed, world not
// initialised): they tell you what the next command will do. Nothing here
// sends a transaction.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Chain, MPL_CORE, PUBLIC_RPC, formatSol, loadKeypair, parseSol, type Cluster } from "../services/chain/solana.mts";
import { FEE_KEYPAIR_MIN, FeeClaimer, GAS_RESERVE_MIN } from "../services/chain/fees.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cluster = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
const rpc = process.env.INSTAR_RPC ?? PUBLIC_RPC[cluster];
const publicCluster = cluster !== "localnet";
let failed = 0;
const ok = (what: string) => console.log(`  ok    ${what}`);
const next = (what: string) => console.log(`  next  ${what}`);
const bad = (what: string) => { failed++; console.log(`  FAIL  ${what}`); };
const warn = (what: string) => console.log(`  WARN  ${what}`);

console.log(`preflight for ${cluster} (${rpc})`);

// ---- the artifact ------------------------------------------------------------
const so = path.join(root, "program/target/deploy/instar.so");
const featuresFile = path.join(root, "program/target/deploy/instar.features");
if (!fs.existsSync(so)) bad("program/target/deploy/instar.so missing: npm run program:build");
else {
  const features = fs.existsSync(featuresFile) ? fs.readFileSync(featuresFile, "utf8").trim() : "unknown";
  if (features === "default") ok(`artifact is the real-timer build (${(fs.statSync(so).size / 1024).toFixed(0)} KB)`);
  else bad(`artifact was built with features "${features}"; npm run program:build`);
}
// The suite and localnet validators preload Core from this dump; without it
// no fly can be minted off a public cluster.
const coreSo = path.join(root, "program/deps/mpl_core.so");
if (fs.existsSync(coreSo)) ok(`program/deps/mpl_core.so (${(fs.statSync(coreSo).size / 1024).toFixed(0)} KB) for local validators`);
else bad("program/deps/mpl_core.so missing: solana program dump -u m CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d program/deps/mpl_core.so");

// ---- the program identity ----------------------------------------------------
const lib = fs.readFileSync(path.join(root, "program/programs/instar/src/lib.rs"), "utf8");
const declared = lib.match(/declare_id!\("([^"]+)"\)/)?.[1] ?? "";
const idl = JSON.parse(fs.readFileSync(path.join(root, "services/chain/idl/instar.json"), "utf8"));
const keep = path.join(root, ".keys/instar-program.json");
if (!fs.existsSync(keep)) bad(".keys/instar-program.json missing: the program identity");
else {
  const kp = loadKeypair(keep).publicKey.toBase58();
  if (kp === declared && idl.address === declared) ok(`program id ${declared} (keypair, declare_id! and IDL agree)`);
  else bad(`program id mismatch: keypair ${kp}, declare_id! ${declared}, IDL ${idl.address}`);
}
const toml = fs.readFileSync(path.join(root, "program/Anchor.toml"), "utf8");
const tomlIds = [...toml.matchAll(/^instar = "([^"]+)"/gm)].map((m) => m[1]);
if (tomlIds.length && tomlIds.every((v) => v === declared)) ok("Anchor.toml program ids agree");
else bad(`Anchor.toml program ids ${tomlIds.join(", ")} differ from ${declared}`);
// The site pins the program it signs for (site/chain.js PROGRAM_ID); a
// rotation that forgets it would ship a page refusing every wallet action.
const sitePin = fs.readFileSync(path.join(root, "site/chain.js"), "utf8").match(/export const PROGRAM_ID = "([^"]+)"/)?.[1] ?? "";
if (sitePin === idl.address) ok(`site/chain.js pins program ${sitePin} (matches the IDL)`);
else bad(`site/chain.js pins program ${sitePin || "(none)"} but the IDL is ${idl.address}: update PROGRAM_ID in site/chain.js`);

// ---- the keys ------------------------------------------------------------------
const deployerPath = path.resolve(root, process.env.INSTAR_DEPLOYER_KEYPAIR ?? process.env.INSTAR_OPERATOR_KEYPAIR ?? ".keys/operator.json");
let deployer: Keypair | null = null;
if (!fs.existsSync(deployerPath)) bad(`deployer/operator keypair missing: ${deployerPath}`);
else { deployer = loadKeypair(deployerPath); ok(`operator ${deployer.publicKey.toBase58()} (${path.relative(root, deployerPath)})`); }

let recovery: PublicKey | null = null;
if (process.env.INSTAR_RECOVERY) {
  recovery = new PublicKey(process.env.INSTAR_RECOVERY);
  if (deployer && recovery.equals(deployer.publicKey)) bad("INSTAR_RECOVERY is the operator key; it must be a different wallet");
  else ok(`recovery ${recovery.toBase58()}`);
} else if (publicCluster) bad("INSTAR_RECOVERY is not set");
else next("localnet: init-world.mts writes a throwaway .keys/recovery.json");

const master = process.env.INSTAR_MASTER_KEY ?? "";
if (/^[0-9a-f]{64}$/i.test(master)) ok("INSTAR_MASTER_KEY is 32 bytes of hex");
else if (publicCluster) bad("INSTAR_MASTER_KEY must be set (64 hex chars) on a public cluster; scripts/new-keys.mts writes one");
else next("INSTAR_MASTER_KEY unset: localnet derives one from the operator key");

let feeKey: Keypair | null = null;
if (process.env.INSTAR_FEE_KEYPAIR) {
  const p = path.resolve(root, process.env.INSTAR_FEE_KEYPAIR);
  if (fs.existsSync(p)) { feeKey = loadKeypair(p); ok(`fee keypair ${feeKey.publicKey.toBase58()}`); } else bad(`INSTAR_FEE_KEYPAIR not found: ${p}`);
} else next("INSTAR_FEE_KEYPAIR unset: the world will not sweep creator fees until it is");
let coinMint: PublicKey | null = null;
if (process.env.INSTAR_COIN_MINT) {
  try { coinMint = new PublicKey(process.env.INSTAR_COIN_MINT); } catch { bad(`INSTAR_COIN_MINT is not a Solana address: ${process.env.INSTAR_COIN_MINT}`); }
  if (coinMint && !feeKey) bad("INSTAR_COIN_MINT is set but INSTAR_FEE_KEYPAIR is not: nothing can claim the coin's fees");
} else next("INSTAR_COIN_MINT unset: the world sweeps the fee keypair but claims no creator fees (docs/COIN.md)");

if (publicCluster && rpc === PUBLIC_RPC[cluster]) next(`using the public RPC ${rpc}; it rate-limits, set INSTAR_RPC to a paid endpoint for a live world`);

// ---- the cluster ---------------------------------------------------------------
try {
  const chain = new Chain({ cluster, rpc, operator: deployer ?? Keypair.generate() });
  const version = await chain.connection.getVersion();
  ok(`rpc reachable (solana-core ${version["solana-core"]})`);
  const hash = await chain.connection.getGenesisHash();
  const known: Record<string, string> = {
    "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  };
  if (known[cluster] && hash !== known[cluster]) bad(`rpc genesis hash ${hash} is not ${cluster}`);
  else ok(`genesis hash confirms ${cluster}`);

  // Every fly is a Metaplex Core asset, so the Core program must be on the
  // target cluster (it is, on devnet and mainnet; localnet preloads it).
  const core = await chain.connection.getAccountInfo(MPL_CORE);
  if (core?.executable) ok(`Metaplex Core is deployed at ${MPL_CORE.toBase58()}`);
  else bad(`Metaplex Core (${MPL_CORE.toBase58()}) is not deployed on ${rpc}${cluster === "localnet" ? ": restart the validator with npm run localnet (it preloads program/deps/mpl_core.so)" : ""}`);

  // The coin's creator fees can only reach the dish if the bonding curve
  // names the fee keypair as creator; that is set once, at launch, and
  // cannot be changed by us afterwards.
  if (coinMint && feeKey) {
    const mintInfo = await chain.connection.getAccountInfo(coinMint);
    if (!mintInfo) bad(`INSTAR_COIN_MINT ${coinMint.toBase58()} does not exist on ${cluster}`);
    else {
      ok(`$INSTAR mint ${coinMint.toBase58()} exists (owner ${mintInfo.owner.toBase58()})`);
      const s = await new FeeClaimer({ chain, mint: coinMint, fee: feeKey }).status();
      if (!s.curve) bad(`no pump.fun bonding curve for ${coinMint.toBase58()}: the coin was not launched on pump.fun, so there are no creator fees to claim`);
      else {
        if (!s.curve.creator.equals(feeKey.publicKey)) {
          bad(`bonding curve creator is ${s.curve.creator.toBase58()}, not the fee keypair ${feeKey.publicKey.toBase58()}: every creator fee this coin earns goes to that wallet instead of the dish, and pump.fun does not let us change it (docs/COIN.md)`);
        } else {
          ok("bonding curve creator is the fee keypair: creator fees go to the dish");
          for (const p of s.problems) bad(p);
          for (const p of s.poolProblems) bad(`PumpSwap: ${p}; the bonding-curve vault is still claimed`);
        }
        if (s.curve.complete) ok(`graduated: canonical PumpSwap pool ${s.pool ? s.pool.address.toBase58() : "not found yet"}`);
        else ok("still on the bonding curve (not graduated)");
        ok(`claimable now: ${formatSol(s.curveVault.claimable)} SOL on the curve, ${formatSol(s.ammVault.amount)} SOL on PumpSwap${s.creatorWsol.amount > 0n ? `, ${formatSol(s.creatorWsol.amount)} SOL unclosed in the fee keypair's wSOL account` : ""}`);
        // Every claim is paid by the fee keypair and only a claim ever pays
        // it: unfunded, it can never make the first one (docs/COIN.md §1).
        if (s.feeBalance >= FEE_KEYPAIR_MIN) ok(`fee keypair holds ${formatSol(s.feeBalance)} SOL for claim fees`);
        else bad(`fee keypair holds ${formatSol(s.feeBalance)} SOL; it pays every claim and nothing funds it but a claim, so seed it with at least ${formatSol(FEE_KEYPAIR_MIN)} SOL: npx tsx scripts/operator.mts fund-fee-keypair ${FEE_KEYPAIR_MIN}`);
        const reserve = parseSol(process.env.INSTAR_GAS_RESERVE ?? "0.05");
        if (reserve < GAS_RESERVE_MIN) warn(`INSTAR_GAS_RESERVE is ${formatSol(reserve)} SOL; the sweep would leave less than a wSOL account's rent (${formatSol(s.ataRent)} SOL) plus a fee, and the next PumpSwap claim would fail; keep at least ${formatSol(GAS_RESERVE_MIN)}`);
      }
    }
  }

  if (deployer) {
    const bal = await chain.balance(deployer.publicKey);
    const rentForProgram = fs.existsSync(so) ? await chain.connection.getMinimumBalanceForRentExemption(fs.statSync(so).size * 2 + 45) : 0;
    const need = BigInt(rentForProgram) + BigInt(LAMPORTS_PER_SOL) / 2n;
    const deployed = await chain.connection.getAccountInfo(chain.programId);
    if (deployed) {
      ok(`program is deployed at ${chain.programId.toBase58()}`);
      if (bal >= BigInt(LAMPORTS_PER_SOL) / 10n) ok(`operator holds ${formatSol(bal)} SOL for fees and rent`);
      else bad(`operator holds ${formatSol(bal)} SOL; keep at least 0.1 SOL for births, epochs and rent`);
    } else {
      next(`program not deployed yet: npm run program:deploy (needs about ${formatSol(need)} SOL)`);
      if (bal >= need) ok(`operator holds ${formatSol(bal)} SOL, enough to deploy`);
      else bad(`operator holds ${formatSol(bal)} SOL; deploying needs about ${formatSol(need)} SOL`);
    }
    if (await chain.worldExists()) {
      const w = await chain.world();
      if (w.operator.equals(deployer.publicKey)) ok(`world exists; operator is this key`); else bad(`world exists but its operator is ${w.operator.toBase58()}`);
      if (recovery && !w.recovery.equals(recovery)) bad(`world recovery is ${w.recovery.toBase58()}, not INSTAR_RECOVERY`);
      else ok(`world recovery ${w.recovery.toBase58()}`);
      const collection = await chain.connection.getAccountInfo(w.collection);
      if (collection?.owner.equals(MPL_CORE)) ok(`world collection ${w.collection.toBase58()} is a Core account`);
      else bad(`world collection ${w.collection.toBase58()} is ${collection ? "not a Core account" : "missing"}`);
      if (w.windDown) bad("world is winding down"); else ok(`world running: ${w.nextId} born, epoch ${w.lastEpoch}`);
    } else next("world not initialised yet: program:deploy does it, or npm run world:init");
  }
} catch (e: any) {
  bad(`rpc ${rpc}: ${String(e?.message ?? e).slice(0, 120)}`);
}

// ---- the engine and the site ------------------------------------------------------
const wasm = path.join(root, "site/instar_sim.wasm");
if (fs.existsSync(wasm)) ok(`engine site/instar_sim.wasm (${fs.statSync(wasm).size} bytes)`); else bad("site/instar_sim.wasm missing: npm run sim:build");
for (const f of ["site/index.html", "site/cage.html", "data/canonical/male-cns-v1.0.census.cbg", "data/canonical/male-cns-v1.0.nodes.json", "data/canonical/male-cns-v1.0.census.json", "services/chain/idl/instar.ts"]) {
  if (fs.existsSync(path.join(root, f))) ok(f); else bad(`${f} missing`);
}
try {
  execFileSync(process.execPath, [path.join(root, "scripts/roles-check.mjs")], { stdio: "pipe" });
  ok("the three role maps are identical (roles-check)");
} catch { bad("roles-check failed: npm run roles:check"); }

console.log(failed ? `\npreflight: ${failed} problem(s)` : "\npreflight: ready");
process.exit(failed ? 1 : 0);
