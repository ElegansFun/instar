// Create the World account and its NFT collection: init_world(recovery,
// collection_uri). Idempotent; prints the existing world if it is already
// there. Run from Windows:
//   npx tsx scripts/init-world.mts
// Env: INSTAR_CLUSTER (default localnet), INSTAR_RPC, INSTAR_PROGRAM_ID (default
//      the IDL address), INSTAR_OPERATOR_KEYPAIR (default .keys/operator.json;
//      pays the rent, must be the program's upgrade authority, becomes the
//      operator), INSTAR_RECOVERY (required on mainnet-beta and devnet; on
//      localnet a throwaway recovery keypair is written to .keys/recovery.json),
//      INSTAR_COLLECTION_URI (the collection's metadata JSON; default
//      ${PUBLIC_URL}/api/collection.json, which the world serves; PUBLIC_URL
//      defaults to http://localhost:8787). The URI is written into the
//      Collection asset at creation, so set PUBLIC_URL to the real origin.
// The program refuses recovery == operator: the address that catches an
// abandoned world's money must not be the key whose loss abandons it.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Chain, PUBLIC_RPC, formatSol, loadKeypair, type Cluster } from "../services/chain/solana.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cluster = (process.env.INSTAR_CLUSTER ?? "localnet") as Cluster;
if (!(cluster in PUBLIC_RPC)) throw new Error(`INSTAR_CLUSTER must be one of ${Object.keys(PUBLIC_RPC).join(", ")}`);

const operatorPath = path.resolve(root, process.env.INSTAR_OPERATOR_KEYPAIR ?? ".keys/operator.json");
let operator: Keypair;
if (fs.existsSync(operatorPath)) {
  operator = loadKeypair(operatorPath);
} else if (cluster === "mainnet-beta") {
  throw new Error(`operator keypair not found: ${operatorPath}`);
} else {
  operator = Keypair.generate();
  fs.mkdirSync(path.dirname(operatorPath), { recursive: true });
  fs.writeFileSync(operatorPath, JSON.stringify(Array.from(operator.secretKey)));
  console.log(`created operator keypair ${operatorPath}`);
}

let recovery: PublicKey;
if (process.env.INSTAR_RECOVERY) {
  recovery = new PublicKey(process.env.INSTAR_RECOVERY);
  if (recovery.equals(operator.publicKey)) throw new Error("INSTAR_RECOVERY must not be the operator key: it is where the money goes when that key is lost");
} else if (cluster === "localnet") {
  const recoveryPath = path.join(root, ".keys", "recovery.json");
  if (!fs.existsSync(recoveryPath)) fs.writeFileSync(recoveryPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  recovery = loadKeypair(recoveryPath).publicKey;
} else {
  throw new Error(`INSTAR_RECOVERY is required on ${cluster}: it is fixed at init and only the live operator can move it`);
}

const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
const collectionUri = process.env.INSTAR_COLLECTION_URI ?? `${publicUrl}/api/collection.json`;
if (cluster !== "localnet" && /localhost|127\.0\.0\.1/.test(collectionUri)) {
  throw new Error(`collection URI ${collectionUri} points at localhost; set PUBLIC_URL or INSTAR_COLLECTION_URI to the public origin`);
}

const chain = new Chain({ cluster, rpc: process.env.INSTAR_RPC, programId: process.env.INSTAR_PROGRAM_ID, operator });
console.log(`cluster:  ${cluster} (${chain.rpcShown})`);
console.log(`program:  ${chain.programId.toBase58()}`);
console.log(`world:    ${chain.worldPda.toBase58()}`);
console.log(`operator: ${operator.publicKey.toBase58()} (${formatSol(await chain.balance(operator.publicKey))})`);

if (await chain.worldExists()) {
  const w = await chain.world();
  console.log(`world already exists: operator ${w.operator.toBase58()}, recovery ${w.recovery.toBase58()}, collection ${w.collection.toBase58()}, next_id ${w.nextId}`);
} else {
  if (cluster === "localnet" && (await chain.balance(operator.publicKey)) < 1_000_000_000n) {
    await chain.airdrop(operator.publicKey, 100_000_000_000n);
  }
  const sig = await chain.initWorld(recovery, collectionUri);
  const w = await chain.world();
  console.log(`init_world: ${sig}`);
  console.log(`recovery: ${recovery.toBase58()}`);
  console.log(`collection: ${w.collection.toBase58()} (${collectionUri})`);
}
