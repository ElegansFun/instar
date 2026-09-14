// The backup archive: a plain ustar tar, gzipped, written and read here with
// no dependency so `tar tzf` and any archiver open it. Both makers of one —
// scripts/backup.mts from the files in DATA_DIR, and GET /api/backup from
// the live objects in the world process — pack it with this.

import * as zlib from "zlib";

export type Entry = { name: string; data: Buffer; mtime: number };

/// What a backup holds, in copy order: the snapshot before the journal. The
/// world only resumes from a snapshot no newer than the journal, so that
/// order is the one that always restores by resuming rather than replaying.
/// The snapshot is the world's gzip image (~0.6 GB of engine memory raw).
export const BACKUP_FILES = ["snapshot.bin.gz", "journal.json", "journal.json.bak", "accounts.json", "accounts.json.bak", "genesis.lock", "accounts.json.unreadable.json"];
const BLOCK = 512;

function octal(n: number, width: number): Buffer {
  return Buffer.from(n.toString(8).padStart(width - 1, "0") + "\0", "latin1");
}

function header(name: string, size: number, mtime: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`name too long for ustar: ${name}`);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, "utf8");
  octal(0o644, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(Math.floor(mtime / 1000), 12).copy(h, 136);
  h.fill(0x20, 148, 156);           // checksum field counts as spaces
  h.write("0", 156, "latin1");      // regular file
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  h.write("instar", 265, "latin1");
  h.write("instar", 297, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "latin1").copy(h, 148);
  return h;
}

export function pack(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e.name, e.data.length, e.mtime), e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export function unpack(tar: Buffer): Entry[] {
  const out: Entry[] = [];
  let at = 0;
  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every(b => b === 0)) break;
    const stored = parseInt(h.toString("latin1", 148, 156).replace(/[\0 ]+$/, ""), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== stored) throw new Error(`bad tar header checksum at byte ${at}`);
    const name = h.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const size = parseInt(h.toString("latin1", 124, 136).replace(/[\0 ]+$/, ""), 8);
    const mtime = parseInt(h.toString("latin1", 136, 148).replace(/[\0 ]+$/, ""), 8) * 1000;
    const type = h.toString("latin1", 156, 157);
    at += BLOCK;
    if (type === "0" || type === "\0") {
      if (name.includes("/") || name.includes("\\") || name.includes("..")) throw new Error(`refusing archive member with a path in it: ${name}`);
      out.push({ name, data: Buffer.from(tar.subarray(at, at + size)), mtime });
    }
    at += size + (BLOCK - (size % BLOCK)) % BLOCK;
  }
  return out;
}

export function gzipArchive(entries: Entry[]): Buffer {
  return zlib.gzipSync(pack(entries), { level: 6 });
}

/// For the world process: the compression runs on the threadpool so the
/// world keeps ticking. Level 1, since the snapshot inside is already gzip.
export function gzipArchiveAsync(entries: Entry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => zlib.gzip(pack(entries), { level: 1 }, (e, out) => e ? reject(e) : resolve(out)));
}

export function gunzipArchive(tgz: Buffer): Entry[] {
  return unpack(zlib.gunzipSync(tgz));
}
