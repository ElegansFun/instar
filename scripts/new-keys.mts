// Mint a fresh set of keys for a public deployment. Run from Windows:
//   npx tsx scripts/new-keys.mts [dir]        (default .keys/mainnet)
//
// Writes, and refuses to overwrite:
//   <dir>/operator.json   the deployer, upgrade authority and world operator
//   <dir>/recovery.json   where an abandoned world's money goes (keep cold)
//   <dir>/fee.json        the $INSTAR creator-fee destination the world sweeps
//   <dir>/master.key      32 random bytes, hex: seals custodial wallets at rest
// and, with --program, rotates the program identity itself:
//   .keys/instar-program.json plus declare_id! in the program source and every
//   [programs.*] entry in program/Anchor.toml. The program must be rebuilt
//   afterwards (npm run program:test) so the artifact and IDL carry the new id.
//
// Only public keys are printed. Back the directory up offline before any of
// these keys holds a lamport; there is no recovery for a lost master key or a
// lost program keypair.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rotateProgram = args.includes("--program");
const dir = path.resolve(root, args.find((a) => !a.startsWith("--")) ?? ".keys/mainnet");
fs.mkdirSync(dir, { recursive: true });

function writeSecret(file: string, bytes: Uint8Array | string) {
  if (fs.existsSync(file)) throw new Error(`${file} exists; refusing to overwrite a key that may already hold funds`);
  fs.writeFileSync(file, typeof bytes === "string" ? bytes : JSON.stringify(Array.from(bytes)), { mode: 0o600 });
}

const made: [string, string][] = [];
for (const name of ["operator", "recovery", "fee"]) {
  const kp = Keypair.generate();
  writeSecret(path.join(dir, `${name}.json`), kp.secretKey);
  made.push([name, kp.publicKey.toBase58()]);
}
writeSecret(path.join(dir, "master.key"), randomBytes(32).toString("hex"));
made.push(["master.key", "32 bytes (INSTAR_MASTER_KEY)"]);

if (rotateProgram) {
  const kp = Keypair.generate();
  const id = kp.publicKey.toBase58();
  const keep = path.join(root, ".keys", "instar-program.json");
  if (fs.existsSync(keep)) fs.renameSync(keep, `${keep}.${Date.now()}.retired`);
  writeSecret(keep, kp.secretKey);
  const lib = path.join(root, "program", "programs", "instar", "src", "lib.rs");
  const toml = path.join(root, "program", "Anchor.toml");
  const idRe = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
  fs.writeFileSync(lib, fs.readFileSync(lib, "utf8").replace(/declare_id!\("[^"]+"\)/, `declare_id!("${id}")`));
  fs.writeFileSync(toml, fs.readFileSync(toml, "utf8").replace(/^(instar = ")([^"]+)(")/gm, (_m, a, _old, c) => `${a}${id}${c}`));
  if (!idRe.test(id)) throw new Error("unreachable: generated id is not base58");
  made.push(["program (rotated)", id]);
}

console.log(`keys written under ${dir}`);
for (const [name, pub] of made) console.log(`  ${name.padEnd(18)} ${pub}`);
console.log(`
next:
  back up ${dir} and .keys/instar-program.json offline
  ${rotateProgram ? "npm run program:test            # rebuild with the new program id\n  " : ""}INSTAR_CLUSTER=mainnet-beta INSTAR_DEPLOYER_KEYPAIR=${path.relative(root, path.join(dir, "operator.json"))} INSTAR_RECOVERY=${made[1][1]} npm run program:deploy`);
