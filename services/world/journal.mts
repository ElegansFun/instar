// The journal is the world's record: every host input, in tick order, so
// the whole history replays bit-identically from the seed. The op queue and
// the epoch clock live here too because they are part of that record, not
// scratch state.

import * as fs from "fs";
import * as path from "path";

export type Entry =
  | { tick: number; type: "cap"; value: number }
  | { tick: number; type: "cull"; uid: number }
  | { tick: number; type: "gen"; n: number }
  | { tick: number; type: "provision"; uid: number };

/// `sig` is null only for an epoch whose post was recovered from the chain
/// after the fact, when its signature could not be found among the World's
/// recent transactions.
export type EpochRec = { epoch: number; tick: number; hash: string; sig: string | null; population: number; maxGen: number };
export type TxRec = { t: number; kind: string; id?: number; sig: string; ok: boolean };
export type LineageName = { name: string; by: string; handle: string; tick: number };

/// Chain work named but not yet landed. Persisted so a restart resumes it
/// instead of skipping a creature id and wedging every birth after it.
export type Op =
  | { op: "birth"; uid: number; parentUid: number; generation: number; tick: number; genomeHash: string }
  | { op: "offer"; uid: number; price: string }
  | { op: "death"; uid: number; cause: number; tick: number; heirs: number[] }
  /// `sent`: a reward transaction went out and was not confirmed; the retry
  /// checks it before paying again.
  | { op: "reward"; uids: number[]; amounts: string[]; sent?: { sig: string; lastValidBlockHeight: number } }
  | { op: "epoch"; tick: number; hash: string; population: number; maxGen: number };

export type Journal = {
  name: "instar";
  cluster: string;
  programId: string;
  seed: string;
  era: number;
  tickrate: number;
  epochInterval: number;
  tick: number;
  entries: Entry[];
  epochs: EpochRec[];
  /// Count of engine events already turned into ops; a replay past this many
  /// events queues nothing, so a restart never double-registers a birth.
  chainSeq: number;
  /// The epoch the world has reached, distinct from `epochs` (the ones that
  /// were published). Deriving the clock from the published list would let
  /// one failed post leave the next boundary behind the world.
  lastEpoch: number;
  lastCreditEpoch: number;
  parents: Record<string, number>;
  children: Record<string, number[]>;
  eatenBase: Record<string, number>;
  creditedEpoch: Record<string, number>;
  txlog: TxRec[];
  ops: Op[];
  lineageNames: Record<string, LineageName>;
};

export type JournalOpts = {
  dir: string;
  cluster: string;
  programId: string;
  seed: bigint;
  tickrate: number;
  epochInterval: number;
  fresh: boolean;
  log: (line: string) => void;
};

const TXLOG_KEEP = 400;
const EPOCHS_KEEP = 200;

/// Write, or leave the previous file untouched. Never a half-written one.
///
/// A bare writeFileSync truncates and rewrites in place; a kill inside that
/// window leaves torn JSON, and the parse at boot is what the world starts
/// from. tmp + fsync + rename makes the swap atomic. The fsync is not
/// optional: rename alone can still leave a zero-length file after a host
/// power loss.
export function writeAtomic(target: string, data: string | Buffer) {
  const tmp = target + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (fs.existsSync(target)) fs.copyFileSync(target, target + ".bak");
  } catch {
    // the backup is best effort; the rename below is what protects the record
  }
  fs.renameSync(tmp, target);
}

export function readJsonWithBackup<T>(file: string, log: (l: string) => void): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log(`${path.basename(file)} is unreadable (${String(e).slice(0, 80)}) — trying the backup`);
    try {
      const v = JSON.parse(fs.readFileSync(file + ".bak", "utf8"));
      log(`recovered from ${path.basename(file)}.bak`);
      return v;
    } catch {
      return null;
    }
  }
}

export class JournalStore {
  readonly path: string;
  readonly lockPath: string;
  readonly journal: Journal;
  persistFailed = "";
  private readonly log: (l: string) => void;

  constructor(opts: JournalOpts) {
    fs.mkdirSync(opts.dir, { recursive: true });
    this.path = path.join(opts.dir, "journal.json");
    this.lockPath = path.join(opts.dir, "genesis.lock");
    this.log = opts.log;
    this.journal = this.load(opts);
  }

  private fresh(opts: JournalOpts): Journal {
    return {
      name: "instar", cluster: opts.cluster, programId: opts.programId,
      seed: opts.seed.toString(), era: 1, tickrate: opts.tickrate, epochInterval: opts.epochInterval,
      tick: 0, entries: [], epochs: [], chainSeq: 0, lastEpoch: 0, lastCreditEpoch: 0,
      parents: {}, children: {}, eatenBase: {}, creditedEpoch: {}, txlog: [], ops: [], lineageNames: {},
    };
  }

  private load(opts: JournalOpts): Journal {
    const fresh = this.fresh(opts);
    const world = `${opts.cluster}:${opts.programId}`;
    // INSTAR_FRESH=1 is meant to be pulled once, to start a world against a
    // new program. Left set in a deployment environment it is a trap: every
    // restart wipes the journal while the program keeps its creatures, and the
    // two can never agree again. So genesis is recorded against the program it
    // was for, and a second fresh boot for the SAME program is ignored.
    if (opts.fresh) {
      let lockedTo = "";
      try { lockedTo = JSON.parse(fs.readFileSync(this.lockPath, "utf8")).world; } catch { /* no lock yet */ }
      if (lockedTo === world && fs.existsSync(this.path)) {
        this.log("INSTAR_FRESH=1 ignored — this world already had its genesis on this program");
      } else {
        this.log("INSTAR_FRESH=1 — new world");
        fs.writeFileSync(this.lockPath, JSON.stringify({ world, at: Date.now() }));
        return fresh;
      }
    }
    const parsed = readJsonWithBackup<Partial<Journal>>(this.path, this.log);
    if (!parsed) return fresh;
    // a journal from another program or cluster must never replay onto this one
    if (parsed.cluster !== opts.cluster || parsed.programId !== opts.programId) {
      this.log(`journal is for ${parsed.cluster}:${parsed.programId}, not ${world} — starting fresh`);
      return fresh;
    }
    return { ...fresh, ...parsed };
  }

  /// A journal that has silently stopped advancing while the world keeps
  /// settling on-chain is the worst of both, so a failed write is loud and
  /// visible in /api/journal rather than swallowed.
  persist() {
    try {
      writeAtomic(this.path, JSON.stringify(this.journal));
      this.persistFailed = "";
    } catch (e: any) {
      this.persistFailed = String(e?.message ?? e).slice(0, 120);
      this.log("JOURNAL WRITE FAILED — " + this.persistFailed);
    }
  }

  logTx(kind: string, sig: string, ok: boolean, id?: number) {
    if (!sig) return;
    const rec: TxRec = { t: Date.now(), kind, sig, ok };
    if (id !== undefined && id >= 0) rec.id = id;
    this.journal.txlog.push(rec);
    if (this.journal.txlog.length > TXLOG_KEEP) this.journal.txlog.splice(0, this.journal.txlog.length - TXLOG_KEEP);
  }

  recordEpoch(rec: EpochRec) {
    this.journal.epochs.push(rec);
    if (this.journal.epochs.length > EPOCHS_KEEP) this.journal.epochs.splice(0, this.journal.epochs.length - EPOCHS_KEEP);
  }

  addEntry(e: Entry) {
    this.journal.entries.push(e);
    this.persist();
  }
}
