// The operator's hourly chores, from a machine that is not the host:
//   1. pull a backup of the live world (journal, snapshot, sealed accounts)
//   2. verify the latest posted epoch against the chain and post the verdict
//   3. keep the newest 48 backups
// Reads INSTAR_ADMIN_TOKEN from the Railway env (railway CLI, linked project)
// unless it is already set, and the RPC from .keys/mainnet/rpc.env. Every
// line is timestamped; stdout goes to backups/hourly.log via the task.
//   node scripts/hourly.mjs [--url https://instarcage.com]
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const url = args[args.indexOf("--url") + 1] || "https://instarcage.com";
const log = (s) => console.log(`[hourly ${new Date().toISOString()}] ${s}`);
const env = { ...process.env, INSTAR_URL: url };
if (!env.INSTAR_ADMIN_TOKEN) {
  const kv = execFileSync("railway", ["variables", "--kv"], { cwd: root, encoding: "utf8", shell: true });
  env.INSTAR_ADMIN_TOKEN = (kv.match(/^INSTAR_ADMIN_TOKEN=(.+)$/m) || [])[1] || "";
}
if (!env.INSTAR_ADMIN_TOKEN) { log("no INSTAR_ADMIN_TOKEN; nothing done"); process.exit(1); }
if (!env.INSTAR_RPC) {
  try { env.INSTAR_RPC = fs.readFileSync(path.join(root, ".keys", "mainnet", "rpc.env"), "utf8").match(/INSTAR_RPC_MAINNET=(\S+)/)[1]; } catch { /* public rpc */ }
}
const run = (label, cmd, a) => {
  const r = spawnSync(cmd, a, { cwd: root, env, encoding: "utf8", shell: true, timeout: 20 * 60_000 });
  const out = (r.stdout + r.stderr).replace(/api-key=[a-z0-9-]+/g, "api-key=<redacted>");
  const last = out.trim().split("\n").filter(Boolean).slice(-2).join(" | ");
  log(`${label}: exit ${r.status}: ${last}`);
  return r.status === 0;
};
run("backup", "npx", ["tsx", "scripts/backup.mts", "--pull", url]);
run("verify", "npm", ["run", "-s", "verify:epoch", "--", "--world", url, "--post"]);
const dir = path.join(root, "backups");
const old = fs.readdirSync(dir).filter(f => /^instar-.*\.tgz$/.test(f)).sort().reverse().slice(48);
for (const f of old) fs.unlinkSync(path.join(dir, f));
if (old.length) log(`pruned ${old.length} old backup(s)`);
