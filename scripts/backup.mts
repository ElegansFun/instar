// Back the world's record up, and put it back. Run from Windows:
//
//   npx tsx scripts/backup.mts                    DATA_DIR -> backups/instar-<cluster>-<iso>.tgz
//   npx tsx scripts/backup.mts --pull <url>       GET <url>/api/backup from the live world -> the same
//   npx tsx scripts/backup.mts --list <file>      what an archive holds
//   npx tsx scripts/backup.mts --restore <file>   archive -> DATA_DIR; the world must be stopped
//                              [--force]          ...even from another cluster/program, or an older tick
//
// Env: DATA_DIR (default data/world), PORT (default 8787: --restore refuses
// while something answers there), INSTAR_BACKUP_DIR (default backups/),
// INSTAR_ADMIN_TOKEN (for --pull: the world's token, sent as a bearer).
//
// The archive is a plain ustar tar, gzipped (services/world/archive.mts), so
// `tar tzf` and any archiver open it. What goes in: the journal (the
// replayable record and the op queue), its .bak, the snapshot, the custodial
// accounts (THE ONLY COPY OF EVERY KEEPER'S KEY; sealed under the master key,
// so the archive is only as secret as that key is), their .bak, sessions, the
// genesis lock and the quarantine file. Each file is copied into a staging
// directory under a temporary name and renamed into place, so the staging
// set never holds a half-copied file, and the snapshot is copied before the
// journal: the world only resumes from a snapshot no newer than the journal,
// so that order is the one that always restores by resuming rather than
// replaying. --pull gets the same archive built by the process from its live
// objects, which is how a scheduler outside the host takes a copy that
// survives the host.
//
// --restore refuses while DATA_DIR/world.lock is held by a live process (the
// world holds it from before it reads a file, so a booting world counts) or
// anything answers on PORT. It moves whatever is in DATA_DIR aside to
// DATA_DIR/pre-restore-<iso> before the archive's files are renamed in, so a
// restore never destroys the record it replaces — and accounts.json is
// MERGED, not replaced: a keeper who signed up after the backup has a key
// that exists only in the current file, and the restore must not lose it.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_FILES, gunzipArchive, gzipArchive, type Entry } from "../services/world/archive.mts";
import { lockHolder, writeAtomic } from "../services/world/journal.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(root, process.env.DATA_DIR ?? "data/world");
const backupDir = path.resolve(root, process.env.INSTAR_BACKUP_DIR ?? "backups");
const port = Number(process.env.PORT ?? 8787);

// ---- helpers ----------------------------------------------------------------

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
const mb = (n: number) => (n / 1e6).toFixed(2) + " MB";

function portOpen(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

/// In the container the tree is /app and the volume is /data; an archive
/// written under /app is gone on the next deploy, which is no backup at all.
function checkBackupDir() {
  const inApp = root === "/app" || root.startsWith("/app/");
  if (!process.env.INSTAR_BACKUP_DIR && inApp && path.isAbsolute(process.env.DATA_DIR ?? "")) {
    throw new Error(`refusing the default backup directory ${backupDir}: it is inside the container image and does not survive a deploy — set INSTAR_BACKUP_DIR, or pull the archive from outside with --pull`);
  }
  fs.mkdirSync(backupDir, { recursive: true });
}

/// Write the archive under a temporary name, read it back, then give it its
/// name. A backup that cannot be opened is worse than none, because it looks
/// like one; a zero-length one after a power loss is the same, hence the fsync.
function storeArchive(cluster: string, tgz: Buffer, expected: Entry[] | null): string {
  const target = path.join(backupDir, `instar-${cluster}-${stamp()}.tgz`);
  const tmp = target + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try { fs.writeFileSync(fd, tgz); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const check = gunzipArchive(fs.readFileSync(tmp));
  if (!check.some(e => e.name === "journal.json")) throw new Error("verification failed: no journal.json in the archive");
  for (const e of expected ?? []) {
    const back = check.find(c => c.name === e.name);
    if (!back || !back.data.equals(e.data)) throw new Error(`verification failed: ${e.name} does not read back`);
  }
  fs.renameSync(tmp, target);
  console.log(`${target} (${mb(fs.statSync(target).size)})`);
  for (const e of check) console.log(`  ${e.name.padEnd(30)} ${mb(e.data.length).padStart(10)}  ${new Date(e.mtime).toISOString()}`);
  return target;
}

const journalOf = (entries: Entry[]) => {
  const j = entries.find(e => e.name === "journal.json");
  return j ? JSON.parse(j.data.toString("utf8")) : null;
};
const describeJournal = (j: any) => `${j.cluster} ${j.programId} era ${j.era} tick ${j.tick} epoch ${j.lastEpoch}, ${j.ops?.length ?? 0} op(s) queued`;

/// The file, or its .bak when the file is torn: the same rule the world reads by.
function readJsonOrBak<T>(file: string): T | null {
  for (const f of [file, file + ".bak"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* next */ }
  }
  return null;
}

// ---- commands ---------------------------------------------------------------

function backup() {
  if (!fs.existsSync(path.join(dataDir, "journal.json"))) throw new Error(`no journal.json in ${dataDir} — nothing to back up`);
  let cluster = process.env.INSTAR_CLUSTER ?? "unknown";
  try { cluster = JSON.parse(fs.readFileSync(path.join(dataDir, "journal.json"), "utf8")).cluster ?? cluster; } catch { /* the .bak may still be good; the archive says what it holds */ }
  checkBackupDir();
  const stage = fs.mkdtempSync(path.join(backupDir, ".stage-"));
  const entries: Entry[] = [];
  try {
    for (const name of BACKUP_FILES) {
      const src = path.join(dataDir, name);
      if (!fs.existsSync(src)) continue;
      const tmp = path.join(stage, name + ".copying"), dst = path.join(stage, name);
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dst);
      entries.push({ name, data: fs.readFileSync(dst), mtime: fs.statSync(src).mtimeMs });
    }
    if (!entries.some(e => e.name === "accounts.json") && fs.existsSync(path.join(dataDir, "accounts.json"))) throw new Error("accounts.json was not copied");
    storeArchive(cluster, gzipArchive(entries), entries);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/// The world builds the archive from its live objects and hands it over the
/// token-gated route; nothing here touches DATA_DIR.
async function pull(url: string) {
  const token = process.env.INSTAR_ADMIN_TOKEN;
  if (!token) throw new Error("--pull needs INSTAR_ADMIN_TOKEN (the world's)");
  checkBackupDir();
  const res = await fetch(`${url.replace(/\/$/, "")}/api/backup`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const j = journalOf(gunzipArchive(tgz));
  if (!j) throw new Error("the world sent an archive with no journal.json");
  console.log(`pulled from ${url}: ${describeJournal(j)}`);
  storeArchive(j.cluster ?? "unknown", tgz, null);
}

function list(file: string) {
  const entries = gunzipArchive(fs.readFileSync(file));
  for (const e of entries) console.log(`  ${e.name.padEnd(30)} ${mb(e.data.length).padStart(10)}  ${new Date(e.mtime).toISOString()}`);
  const j = journalOf(entries);
  if (j) console.log(`  journal: ${describeJournal(j)}`);
}

async function restore(file: string, force: boolean) {
  const held = lockHolder(dataDir);
  if (held?.alive) throw new Error(`${dataDir}/world.lock is held by pid ${held.pid}, alive since ${new Date(held.startedAt).toISOString()} — stop the world process before restoring (it would write its own record back over this)`);
  if (await portOpen()) throw new Error(`something answers on :${port} — stop the world process before restoring (it would write its own record back over this)`);
  const entries = gunzipArchive(fs.readFileSync(file));
  const archived = journalOf(entries);
  if (!archived) throw new Error(`${file} holds no journal.json`);
  console.log(`archive:  ${describeJournal(archived)}`);
  const current = readJsonOrBak<any>(path.join(dataDir, "journal.json"));
  if (current) {
    console.log(`current:  ${describeJournal(current)}`);
    const other = current.cluster !== archived.cluster || current.programId !== archived.programId;
    if (other && !force) throw new Error(`the archive is for ${archived.cluster}:${archived.programId}, DATA_DIR holds ${current.cluster}:${current.programId} — the world would start fresh against a program that already holds its larvae; --force if that is really what you want`);
    if (!other && archived.tick < current.tick && !force) throw new Error(`the archive is at tick ${archived.tick}, older than the current record at ${current.tick} — restore only from a newer backup, or --force to roll the record back`);
    if (other || archived.tick < current.tick) console.log(`--force: restoring anyway`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  // the current custody file is merged, not replaced: keys minted since the
  // backup exist nowhere else; for the same user the current record wins
  for (const name of ["accounts.json", "accounts.json.unreadable.json"]) {
    const live = readJsonOrBak<Record<string, unknown>>(path.join(dataDir, name));
    if (!live) continue;
    const entry = entries.find(e => e.name === name);
    const fromArchive: Record<string, unknown> = entry ? JSON.parse(entry.data.toString("utf8")) : {};
    const merged = { ...fromArchive, ...live };
    const added = Object.keys(live).filter(k => !(k in fromArchive)).length;
    const data = Buffer.from(JSON.stringify(merged));
    if (entry) entry.data = data; else entries.push({ name, data, mtime: Date.now() });
    console.log(`${name}: ${Object.keys(fromArchive).length} in the archive + ${added} only in the current file -> ${Object.keys(merged).length}`);
  }
  const aside = path.join(dataDir, `pre-restore-${stamp()}`);
  const present = fs.readdirSync(dataDir).filter(n => n !== "world.lock" && fs.statSync(path.join(dataDir, n)).isFile());
  if (present.length) {
    fs.mkdirSync(aside);
    for (const n of present) fs.renameSync(path.join(dataDir, n), path.join(aside, n));
    console.log(`moved ${present.length} file(s) aside to ${aside}`);
  }
  for (const e of entries) {
    const dst = path.join(dataDir, e.name);
    writeAtomic(dst, e.data);
    fs.utimesSync(dst, new Date(e.mtime), new Date(e.mtime));
    console.log(`  ${e.name.padEnd(30)} ${mb(e.data.length).padStart(10)}`);
  }
  console.log(`restored ${entries.length} file(s) into ${dataDir}; start the world`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const known = ["--restore", "--list", "--pull", "--force"];
  const unknown = argv.filter(a => a.startsWith("--") && !known.includes(a));
  if (unknown.length) throw new Error(`unknown flag(s): ${unknown.join(" ")}`);
  if (argv.includes("--restore")) {
    const file = flag("--restore");
    if (!file || file.startsWith("--")) throw new Error("--restore needs a file");
    await restore(path.resolve(file), argv.includes("--force"));
  } else if (argv.includes("--list")) {
    const file = flag("--list");
    if (!file) throw new Error("--list needs a file");
    list(path.resolve(file));
  } else if (argv.includes("--pull")) {
    const url = flag("--pull");
    if (!url) throw new Error("--pull needs the world's URL");
    await pull(url);
  } else if (argv.length) {
    throw new Error(`unknown arguments: ${argv.join(" ")}`);
  } else {
    backup();
  }
}

main().catch(e => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
