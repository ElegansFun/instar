// Deploy the Instar program to a cluster AND create its World in the same
// run. Run from Windows:
//   npx tsx scripts/deploy-program.mts
// Env: INSTAR_CLUSTER (localnet | devnet | mainnet-beta, default localnet),
//      INSTAR_RPC (override the cluster's default endpoint),
//      INSTAR_DEPLOYER_KEYPAIR (pays for and owns the upgrade; default .keys/operator.json;
//      it is also the operator that init_world records, since only the upgrade
//      authority may create the World),
//      INSTAR_RECOVERY (devnet and mainnet-beta: the recovery address MUST be
//      decided before the program exists).
// The Solana CLI lives in WSL; this script checks the artifact and delegates to
// scripts/wsl-deploy-program.sh, which runs `solana program deploy` and then
// inits or upgrades the on-chain IDL. init_world follows immediately: the World
// PDA is a singleton per program, and although the program only lets the
// upgrade authority create it, a world that exists is a world that cannot be
// mis-created.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { PUBLIC_RPC, type Cluster } from "../services/chain/solana.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cluster = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
if (!(cluster in PUBLIC_RPC)) throw new Error(`INSTAR_CLUSTER must be one of ${Object.keys(PUBLIC_RPC).join(", ")}`);
const rpc = process.env.INSTAR_RPC ?? PUBLIC_RPC[cluster];
const deployer = path.resolve(root, process.env.INSTAR_DEPLOYER_KEYPAIR ?? ".keys/operator.json");
if (!fs.existsSync(deployer)) throw new Error(`deployer keypair not found: ${deployer}`);

const features = path.join(root, "program/target/deploy/instar.features");
const so = path.join(root, "program/target/deploy/instar.so");
if (!fs.existsSync(so)) throw new Error("program/target/deploy/instar.so missing: run npm run program:build first");
const built = fs.existsSync(features) ? fs.readFileSync(features, "utf8").trim() : "unknown";
if (built !== "default") {
  throw new Error(`the artifact on disk was built with features "${built}"; run npm run program:build to get the real-timer build`);
}
// The build script writes the marker last, so a .so that is newer than it was
// produced by a cargo run the script did not make, with features it cannot vouch for.
if (fs.statSync(so).mtimeMs > fs.statSync(features).mtimeMs) {
  throw new Error("program/target/deploy/instar.so is newer than its features marker; run npm run program:build so the artifact is a build the script vouches for");
}

if (cluster !== "localnet") {
  const recovery = process.env.INSTAR_RECOVERY;
  if (!recovery) throw new Error(`INSTAR_RECOVERY is required on ${cluster}: decide where an abandoned world's money goes before it exists`);
  console.log(`recovery (for the following init-world): ${new PublicKey(recovery).toBase58()}`);
}

/// C:/x/y -> /mnt/c/x/y
const wsl = (p: string) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);

execFileSync(
  "wsl",
  ["-d", "Ubuntu-24.04", "-u", "root", "--", "bash", wsl(path.join(root, "scripts/wsl-deploy-program.sh")), cluster, rpc, wsl(deployer)],
  { stdio: "inherit" }
);
execFileSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "scripts", "init-world.mts")], {
  stdio: "inherit",
  env: { ...process.env, INSTAR_CLUSTER: cluster, INSTAR_RPC: rpc, INSTAR_OPERATOR_KEYPAIR: deployer },
});
