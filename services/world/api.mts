// The world's HTTP face: the journal for mirrors, the live stream for the
// site, the market for keepers, the static site. Every trade below is signed
// by the keeper's own custodial key; the operator never buys, sells or moves
// a fly on anyone's behalf.

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Chain, PUBLIC_RPC, STATUS, STATUS_NAME, formatSol, loadIdl, type CreatureView, type WorldView, type Cluster } from "../chain/solana.mts";
import { Accounts } from "./accounts.mts";
import { BACKUP_FILES, gzipArchiveAsync, type Entry as ArchiveEntry } from "./archive.mts";
import { Engine, FIRE_GROUP, POSE } from "./engine.mts";
import { JournalStore, type LineageName, type VerifierRec } from "./journal.mts";
import { OpQueue } from "./ops.mts";
import { flySvg } from "./art.mts";
import { roleCountsOf, ROLE_GROUPS } from "./roles.mts";

/// One /api/stream frame: what the site renders from, ten times a second.
export type StreamFly = {
  id: number; slot: number; gen: number; lin: number; age: number; mode: 0 | 1; s: number;
  x: number; y: number; z: number; h: number; p: number; r: number; e: number;
  wb: number; legs: number[]; pr: number; fired: Record<keyof typeof FIRE_GROUP, number>;
};
/// `seq` numbers events across the process so a client that sees the same
/// event in two frames shows it once; `b` is the engine's second operand
/// (landing surface, death cause, birth parent slot or 255).
export type StreamEvent = { seq: number; tick: number; kind: number; name: string; uid: number; b: number; cause: string | null };
export type Frame = { t: number; light: number; temp: number; flies: StreamFly[]; events: StreamEvent[] };

export type WorldContext = {
  cluster: Cluster;
  googleClientId: string;
  coin: { mint: string | null; creator: string | null };
  build: { commit: string | null; dirty: boolean; at: string | null; wasmSha256: string; censusRoot: string };
  publicUrl: string;
  economy: { offerBase: string; offerPerGen: string; founderPremium: number; rewardEveryEpochs: number; poolPayoutBps: number; sweepIntervalMs: number; sweepPoolBps: number; gasReserve: string };
  corsOrigin: string;
  siteDir: string;
  rootDir: string;
  dataDir: string;
  /// INSTAR_ADMIN_TOKEN; empty disables GET /api/backup
  adminToken: string;
  chain: Chain;
  store: JournalStore;
  engine: Engine;
  accounts: Accounts;
  ops: OpQueue;
  /// how far ahead of the live tick host inputs are scheduled; a mirror
  /// must not run past serverTick + bufferTicks - 1
  bufferTicks: number;
  tick(): number;
  capacity(): number;
  lastEpoch(): number;
  /// where the wall clock and the tick were when this process started
  startedAt: { wall: number; tick: number };
  flies(): CreatureView[];
  world(): WorldView | null;
  refreshChain(): Promise<void>;
  /// the current frame for /api/stream; `consume` (default) takes the
  /// events since the previous consuming call, false leaves them
  frame(consume?: boolean): Frame;
  /// the five-minute gzip image; refreshed first when this process has not
  /// written one yet, or it is older than `refreshAfterMs`
  snapshotFile(refreshAfterMs: number): Promise<string>;
  /// the newest image on disk (five-minute or pre-boundary); written first
  /// only when there is none
  latestSnapshotFile(): Promise<string>;
  /// epochs whose pre-boundary image is retained, ascending
  snapshotEpochs(): number[];
  /// the retained pre-boundary image of `epoch`, or null
  snapshotEpochFile(epoch: number): string | null;
  /// what the engine knows about a fly that may not be on chain yet
  engineFly(id: number): { slot: number; generation: number; lineage: number; genomeHash: string } | null;
  /// the cage geometry the engine simulates, for the renderer
  arena: unknown;
  log(line: string): void;
};

/// What the server knows before the world is built. The port is bound
/// first so a supervisor sees `replaying` (503) instead of a refused
/// connection while the journal replays; `ctx` is set once the world is live.
export type Boot = { ctx: WorldContext | null; tick: number; target: number; site: Site };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".cbg": "application/octet-stream",
};

/// Where the site's files are, and the origin the pages must name in their
/// link-preview tags; known before the world is built
export type Site = { siteDir: string; rootDir: string; publicUrl: string };

function serveStatic(site: Site, url: string, res: http.ServerResponse): boolean {
  let rel: string;
  try { rel = decodeURIComponent(url.split("?")[0]); } catch { return false; }
  if (rel === "/") rel = "/index.html";
  if (rel.includes("\0")) return false;
  const isData = rel.startsWith("/data/canonical/");
  const base = isData ? path.join(site.rootDir, "data", "canonical") : site.siteDir;
  const full = path.resolve(base, "." + (isData ? rel.slice("/data/canonical".length) : rel));
  if (full !== base && !full.startsWith(base + path.sep)) return false;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("cache-control", isData ? "public, max-age=3600" : "no-cache");
  res.setHeader("x-frame-options", "DENY");
  // link previews need absolute URLs and the origin is only known here
  const body = ext === ".html" ? Buffer.from(fs.readFileSync(full, "utf8").replaceAll("{{PUBLIC_URL}}", site.publicUrl)) : fs.readFileSync(full);
  res.setHeader("content-length", String(body.length));
  res.writeHead(200);
  res.end(body);
  return true;
}
const BODY_LIMIT = 64 * 1024;
const AUTH_RATE = { max: 5, windowMs: 60_000 };
/// Behind a reverse proxy the socket address is the proxy's; set
/// INSTAR_TRUST_PROXY=1 to key the rate limit on the LAST X-Forwarded-For
/// element (the one the proxy itself appended; earlier ones are client-supplied).
const TRUST_PROXY = process.env.INSTAR_TRUST_PROXY === "1";
const AIRDROP_LAMPORTS = BigInt(LAMPORTS_PER_SOL);
/// Devnet's faucet rate-limits by IP; when it refuses, the operator tops the
/// account up from its own devnet SOL, enough to buy a fly and cash out.
const DEVNET_TOPUP_LAMPORTS = BigInt(LAMPORTS_PER_SOL) / 5n;
/// GET /api/backup (and /api/snapshot with the admin token) refreshes the
/// on-disk image first if it is older than this; the public route never does
const SNAPSHOT_REFRESH_MS = 60_000;
/// /api/stream frames per second
const STREAM_HZ = 10;
const STREAM_MAX_CLIENTS = 200;
const FIRED_STRIDE_MAX = 64;
/// /api/health: a queue whose head has not moved for this long is stuck
const STUCK_AFTER_MS = 15 * 60_000;
const RPC_PROBE_MS = 5000;
/// /api/health is unauthenticated: the RPC probe behind it is shared by
/// every request inside this window, so the cost per request is nothing
const HEALTH_PROBE_CACHE_MS = 10_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const lamports = (v: bigint) => v.toString();

function flyJson(c: CreatureView) {
  return {
    id: c.id, asset: c.asset.toBase58(), keeper: c.keeper.toBase58(), status: c.status, statusName: STATUS_NAME[c.status],
    vault: lamports(c.vault), salePrice: lamports(c.salePrice), listedBy: c.listedBy.toBase58(), listedAt: c.listedAt, generation: c.generation,
    parentId: c.parentId, pendingCull: c.pendingCull, birthTick: c.birthTick, deathTick: c.deathTick,
    genomeHash: c.genomeHash,
  };
}

export function createServer(boot: Boot): http.Server {
  let live: ReturnType<typeof handler> | null = null;
  const canonicalHost = (() => { try { return new URL(boot.site.publicUrl).host; } catch { return ""; } })();
  return http.createServer((req, res) => {
    // one origin: the OAuth client, the link previews and the pages' own
    // canonical tags all name PUBLIC_URL, so www. and other aliases redirect
    const host = req.headers.host ?? "";
    if (canonicalHost && host !== canonicalHost && host.endsWith("." + canonicalHost)) {
      res.writeHead(301, { location: boot.site.publicUrl + (req.url ?? "/"), "cache-control": "public, max-age=3600" });
      res.end();
      return;
    }
    if (boot.ctx) {
      live ??= handler(boot.ctx);
      return live(req, res);
    }
    // The pages are served while the world replays so a visitor gets the
    // site with its own "replaying" state rather than a JSON error; only
    // the API answers 503 until the world is live.
    const route = (req.url ?? "/").split("?")[0];
    if ((req.method === "GET" || req.method === "HEAD") && !route.startsWith("/api/") && serveStatic(boot.site, req.url ?? "/", res)) return;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-cache");
    res.writeHead(503);
    res.end(JSON.stringify(route === "/api/health"
      ? { ok: false, phase: "replaying", tick: boot.tick, target: boot.target }
      : { error: "the world is replaying its record; try again shortly", phase: "replaying", tick: boot.tick, target: boot.target }));
  });
}

function handler(ctx: WorldContext) {
  const authHits = new Map<string, number[]>();
  const idlJson = JSON.stringify(loadIdl());

  // ---- /api/stream: one frame per period, written to every open client.
  // The timer runs only while someone is listening and re-arms against its
  // own schedule (not against when the last callback happened to run), so
  // an engine tick that holds the event loop delays a frame without lowering
  // the rate. A client that cannot keep up (socket buffer full) is dropped
  // rather than buffered forever.
  const streamClients = new Set<http.ServerResponse>();
  const STREAM_PERIOD_MS = 1000 / STREAM_HZ;
  let streamNext = 0;
  let streamTimer: NodeJS.Timeout | undefined;
  const streamTick = () => {
    streamTimer = undefined;
    if (!streamClients.size) return;
    const data = `data: ${JSON.stringify(ctx.frame())}\n\n`;
    for (const res of streamClients) {
      if (res.writableNeedDrain || res.destroyed) { res.destroy(); streamClients.delete(res); continue; }
      res.write(data);
    }
    streamNext += STREAM_PERIOD_MS;
    const now = Date.now();
    // a stall longer than a period skips frames rather than bunching them;
    // a shorter one is caught up by the next frame going out at once
    if (streamNext < now - STREAM_PERIOD_MS) streamNext = now;
    streamTimer = setTimeout(streamTick, Math.max(0, streamNext - now));
  };
  const openStream = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (streamClients.size >= STREAM_MAX_CLIENTS) throw new HttpError(503, "too many stream clients");
    res.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no",
    });
    res.write(`retry: 2000\ndata: ${JSON.stringify(ctx.frame(false))}\n\n`);
    streamClients.add(res);
    req.on("close", () => streamClients.delete(res));
    if (!streamTimer) { streamNext = Date.now(); streamTimer = setTimeout(streamTick, STREAM_PERIOD_MS); }
  };

  const withTimeout = <T,>(p: Promise<T>, ms: number) => new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });

  type Probe = { rpc: { ok: boolean; slot: number | null; error?: string }; operatorSol: string };
  let probeCache: { at: number; result: Promise<Probe> } | null = null;
  const probe = (): Promise<Probe> => {
    const now = Date.now();
    if (probeCache && now - probeCache.at < HEALTH_PROBE_CACHE_MS) return probeCache.result;
    const result = withTimeout(Promise.all([
      ctx.chain.connection.getSlot("confirmed"),
      ctx.chain.balance(ctx.chain.operator.publicKey),
    ]), RPC_PROBE_MS).then(
      ([slot, balance]): Probe => ({ rpc: { ok: true, slot }, operatorSol: formatSol(balance) }),
      (e: any): Probe => ({ rpc: { ok: false, slot: null, error: String(e?.message ?? e).slice(0, 120) }, operatorSol: formatSol(ctx.ops.operatorBalance) }),
    );
    probeCache = { at: now, result };
    return result;
  };

  /// What a supervisor needs: is the clock running, is the chain being
  /// written, can the RPC be reached. `ok` is false (and the status 503)
  /// when settlement has held one op for STUCK_AFTER_MS or the RPC does not
  /// answer; a broke operator with nothing queued is reported, not failed.
  const health = async () => {
    const j = ctx.store.journal;
    const now = Date.now();
    const expectedTick = ctx.startedAt.tick + Math.floor(((now - ctx.startedAt.wall) / 1000) * j.tickrate);
    const lastEpochTx = j.txlog.filter(t => t.kind === "epoch" && t.ok).pop();
    const { rpc, operatorSol } = await probe();
    const stuck = ctx.ops.stuckForMs > STUCK_AFTER_MS;
    return {
      ok: rpc.ok && !stuck, phase: "live",
      tick: ctx.tick(), ticksBehindWallClock: Math.max(0, expectedTick - ctx.tick()),
      lastEpochPostedAgoS: lastEpochTx ? Math.floor((now - lastEpochTx.t) / 1000) : null,
      pendingOps: ctx.ops.length, stuckForS: Math.floor(ctx.ops.stuckForMs / 1000), settling: !ctx.ops.outOfGas,
      operatorSol, journalOk: !ctx.store.persistFailed, rpc,
    };
  };

  /// The same archive scripts/backup.mts makes. The snapshot is the world's
  /// gzip image, refreshed first if it is stale (0.6 GB compressed off the
  /// main thread), and the journal is serialized right after the refresh
  /// completes, so the pair is consistent and resumes rather than replays.
  /// The .bak files, genesis.lock and the quarantine file have no live
  /// object and come from the disk. The tar is gzipped off the main thread
  /// too: its bulk is already compressed.
  const backupArchive = async (): Promise<Buffer> => {
    const snapshot = await ctx.snapshotFile(SNAPSHOT_REFRESH_MS);
    const now = Date.now();
    const { accounts, sessions } = ctx.accounts.serialize();
    const liveEntries: Record<string, Buffer> = {
      "journal.json": Buffer.from(JSON.stringify(ctx.store.journal)),
      "accounts.json": Buffer.from(accounts),
      "sessions.json": Buffer.from(sessions),
    };
    const entries: ArchiveEntry[] = [];
    for (const name of BACKUP_FILES) {
      if (liveEntries[name]) { entries.push({ name, data: liveEntries[name], mtime: now }); continue; }
      const file = name === path.basename(snapshot) ? snapshot : path.join(ctx.dataDir, name);
      if (!fs.existsSync(file)) continue;
      entries.push({ name, data: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs });
    }
    return gzipArchiveAsync(entries);
  };

  /// Constant time, length included: a mismatch must not say how much matched.
  const adminAuthorized = (given: string | undefined) => {
    if (!ctx.adminToken || !given) return false;
    const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(ctx.adminToken).digest();
    return crypto.timingSafeEqual(a, b);
  };

  const rateLimit = (ip: string) => {
    const now = Date.now();
    for (const [k, v] of authHits) if (now - v[v.length - 1] >= AUTH_RATE.windowMs) authHits.delete(k);
    const hits = (authHits.get(ip) ?? []).filter(t => now - t < AUTH_RATE.windowMs);
    if (hits.length >= AUTH_RATE.max) throw new HttpError(429, "too many sign-in attempts — wait a minute");
    hits.push(now);
    authHits.set(ip, hits);
  };

  const clientIp = (req: http.IncomingMessage) => {
    const xff = req.headers["x-forwarded-for"];
    if (TRUST_PROXY && xff) {
      const parts = String(xff).split(",");
      return parts[parts.length - 1].trim();
    }
    return req.socket.remoteAddress ?? "";
  };

  const journalView = () => {
    const j = ctx.store.journal, w = ctx.world(), e = ctx.engine;
    return {
      name: "instar", cluster: ctx.cluster, programId: ctx.chain.programId.toBase58(), worldPda: ctx.chain.worldPda.toBase58(),
      explorer: "https://explorer.solana.com", explorerQuery: ctx.chain.explorerQuery,
      seed: j.seed, era: j.era, tick: ctx.tick(), tickrate: j.tickrate, epoch: ctx.lastEpoch(), epochInterval: j.epochInterval,
      bufferTicks: ctx.bufferTicks,
      capacity: ctx.capacity(), entries: j.entries, epochs: j.epochs,
      flies: ctx.flies().map(flyJson),
      metabolism: lamports(w?.metabolism ?? 0n), pool: lamports(w?.pool ?? 0n),
      operator: ctx.chain.operator.publicKey.toBase58(), operatorBalance: lamports(ctx.ops.operatorBalance),
      pendingOps: ctx.ops.length,
      // The site says every event is a transaction. When the operator cannot
      // pay, that stops being true until it is funded, and the page should
      // say so rather than quietly showing a stale world.
      settling: !ctx.ops.outOfGas,
      journalOk: !ctx.store.persistFailed,
      txlog: j.txlog.slice(-200), lineageNames: Object.fromEntries(Object.entries(j.lineageNames).map(([k, r]) => [k, { name: r.name, handle: r.handle, tick: r.tick }])), verifier: j.verifier, snapshotEpochs: ctx.snapshotEpochs(),
      stats: { pop: e.popCount, births: e.births, deaths: e.deaths, kills: e.kills, maxGen: e.maxGeneration },
      onChain: w ? { nextId: w.nextId, totalAlive: w.totalAlive, lastEpoch: w.lastEpoch, windDown: w.windDown } : null,
    };
  };

  const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve, reject) => {
    let body = "";
    req.on("data", c => {
      body += c;
      if (body.length > BODY_LIMIT) { reject(new HttpError(413, "body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new HttpError(400, "invalid JSON")); }
    });
    req.on("error", reject);
  });

  const bearer = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
  };

  const flyById = (id: number) => {
    const c = ctx.flies().find(x => x.id === id);
    if (!c) throw new HttpError(404, `no fly ${id}`);
    return c;
  };

  const parseId = (v: unknown) => {
    const id = Number(v);
    if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "id must be a non-negative integer");
    return id;
  };

  const parseLamports = (v: unknown) => {
    if (typeof v !== "string" && typeof v !== "number") throw new HttpError(400, "lamports must be a decimal string");
    let n: bigint;
    try { n = BigInt(v); } catch { throw new HttpError(400, "lamports must be an integer"); }
    if (n <= 0n) throw new HttpError(400, "amount must be above zero");
    return n;
  };

  const parsePubkey = (v: unknown) => {
    try { return new PublicKey(String(v)); } catch { throw new HttpError(400, "not a Solana address"); }
  };
  // a payout or an NFT must go to something that can sign: a PDA, a token
  // account or a program id would hold it forever
  const parseWallet = (v: unknown) => {
    const k = parsePubkey(v);
    if (!PublicKey.isOnCurve(k.toBytes())) throw new HttpError(400, "not a wallet address (off-curve: a program account or PDA)");
    if (k.equals(ctx.chain.worldPda) || k.equals(ctx.chain.programId)) throw new HttpError(400, "that is the world's own account");
    return k;
  };

  async function post(url: string, req: http.IncomingMessage): Promise<unknown> {
    const p = await readBody(req);
    const ip = clientIp(req);

    if (url === "/api/auth") {
      rateLimit(ip);
      const token = ctx.accounts.signIn(String(p.user ?? ""), String(p.pin ?? ""), p.create === true);
      const user = ctx.accounts.sessionUser(token)!;
      return { token, ...ctx.accounts.profile(user), wallet: ctx.accounts.address(user).toBase58() };
    }
    if (url === "/api/auth/google") {
      rateLimit(ip);
      const token = await ctx.accounts.signInGoogle(String(p.credential ?? ""), ctx.googleClientId);
      const user = ctx.accounts.sessionUser(token)!;
      return { token, ...ctx.accounts.profile(user), wallet: ctx.accounts.address(user).toBase58() };
    }
    if (url === "/api/verifier") {
      // scripts/verify-epoch.mts posts its verdict here so the site can say
      // "verified by the CLI verifier on <date>". Admin-token gated: the
      // claim is the operator's, and an unset token means no such route.
      // The record keeps the set of distinct epochs that verified and the
      // verdict per epoch: a re-run adds nothing, a MISMATCH stays visible.
      if (!ctx.adminToken) throw new HttpError(404, "no such route");
      if (!adminAuthorized(bearer(req))) throw new HttpError(403, "forbidden");
      const epoch = parseId(p.epoch);
      if (!/^[0-9a-f]{16}$/.test(String(p.hash ?? ""))) throw new HttpError(400, "hash must be 16 hex characters");
      if (p.verdict !== "VERIFIED" && p.verdict !== "MISMATCH") throw new HttpError(400, "verdict must be VERIFIED or MISMATCH");
      const prior = ctx.store.journal.verifier;
      const epochs = new Set(prior?.epochs ?? []);
      if (p.verdict === "VERIFIED") epochs.add(epoch); else epochs.delete(epoch);
      const rec: VerifierRec = {
        at: new Date().toISOString(), epoch, hash: String(p.hash), verdict: p.verdict,
        sig: typeof p.sig === "string" && p.sig ? p.sig.slice(0, 96) : null,
        epochs: [...epochs].sort((a, b) => a - b), verdicts: { ...prior?.verdicts, [epoch]: p.verdict },
      };
      ctx.store.journal.verifier = rec;
      ctx.store.persist();
      ctx.log(`verifier: epoch ${epoch} ${rec.verdict} (${rec.epochs.length} distinct epoch(s) verified)`);
      return { ok: true, verifier: rec };
    }

    const who = ctx.accounts.sessionUser(bearer(req));
    if (!who) throw new HttpError(401, "not signed in");
    const keypair = ctx.accounts.keypair(who);
    const me = keypair.publicKey;

    if (url === "/api/me") {
      const [balance, credit] = await Promise.all([ctx.chain.balance(me), ctx.chain.creditOf(me)]);
      const owned = ctx.flies().filter(c => c.status === STATUS.OWNED && c.keeper.equals(me)).map(c => c.id);
      return { ...ctx.accounts.profile(who), wallet: me.toBase58(), balance: lamports(balance), credit: lamports(credit), owned };
    }

    if (url === "/api/name-lineage") {
      // Naming a bloodline is a claim on the record, not a chain action — it
      // costs nothing and lives in the journal beside the lineage. The claim
      // belongs to whoever keeps a living fly of that line.
      const id = parseId(p.id);
      const name = String(p.name ?? "").trim().slice(0, 32);
      if (name.length < 2) throw new HttpError(400, "name it something (2-32 characters)");
      const c = flyById(id);
      if (!c.keeper.equals(me) || c.status !== STATUS.OWNED) throw new HttpError(403, "not yours");
      const eng = ctx.engineFly(id);
      if (!eng) throw new HttpError(409, `#${id} is not in the cage right now`);
      const lineage = eng.lineage;
      const names = ctx.store.journal.lineageNames;
      const held = names[lineage];
      if (held && held.by !== who) throw new HttpError(409, `already named "${held.name}"`);
      const rec: LineageName = { name, by: who, handle: ctx.accounts.profile(who).handle, tick: ctx.tick() };
      names[lineage] = rec;
      ctx.store.persist();
      return { ok: true, lineage, name };
    }

    if (url === "/api/airdrop") {
      if (ctx.cluster === "mainnet-beta") throw new HttpError(400, "mainnet — deposit SOL to your own address instead");
      const held = await ctx.chain.balance(me);
      const target = ctx.cluster === "localnet" ? AIRDROP_LAMPORTS : DEVNET_TOPUP_LAMPORTS;
      if (held >= target) return { ok: true, funded: false, note: "already funded", balance: lamports(held) };
      let sig: string;
      try {
        sig = await ctx.chain.airdrop(me, AIRDROP_LAMPORTS);
        ctx.store.logTx("airdrop", sig, true);
      } catch (e: any) {
        const opBalance = await ctx.chain.balance(ctx.chain.operator.publicKey);
        if (opBalance < target * 5n) throw new HttpError(503, `airdrop refused by the RPC (${String(e?.message ?? e).slice(0, 80)}) — try https://faucet.solana.com`);
        sig = await ctx.chain.sendFromOperator(me, target - held);
        ctx.store.logTx("airdrop", sig, true);
      }
      ctx.store.persist();
      return { ok: true, funded: true, sig, explorer: ctx.chain.explorerTx(sig), balance: lamports(await ctx.chain.balance(me)) };
    }

    const keeper = ctx.chain.asKeeper(keypair);
    const mine = (id: number) => {
      const c = flyById(id);
      if (!c.keeper.equals(me) || c.status !== STATUS.OWNED) throw new HttpError(403, "not yours");
      return c;
    };
    let sig = "", kind = "";
    let id: number | undefined;
    try {
      if (url === "/api/buy") {
        id = parseId(p.id);
        const c = flyById(id);
        if (c.status !== STATUS.OFFERED) throw new HttpError(409, "not offered");
        // the buyer pays the price they were shown, not whatever the seller
        // has changed it to since: the program refuses a mismatch (WrongPrice)
        kind = "buy"; sig = await keeper.buy(id, p.lamports === undefined ? c.salePrice : parseLamports(p.lamports));
      } else if (url === "/api/buylisted") {
        id = parseId(p.id);
        const c = flyById(id);
        if (c.status !== STATUS.OWNED || c.salePrice === 0n) throw new HttpError(409, "not listed");
        if (c.keeper.equals(me)) throw new HttpError(409, "that is already yours");
        kind = "resale"; sig = await keeper.buyListed(id, p.lamports === undefined ? c.salePrice : parseLamports(p.lamports));
      } else if (url === "/api/list") {
        id = parseId(p.id); mine(id);
        kind = "list"; sig = await keeper.list(id, parseLamports(p.lamports));
      } else if (url === "/api/unlist") {
        id = parseId(p.id); mine(id);
        kind = "unlist"; sig = await keeper.unlist(id);
      } else if (url === "/api/transfer") {
        // a Core transfer signed by the custodial owner, exactly what a
        // wallet would send; the program is not involved
        id = parseId(p.id); mine(id);
        const to = parsePubkey(p.to);
        if (to.equals(me)) throw new HttpError(400, "that is your own address");
        kind = "transfer"; sig = await keeper.transferAsset(id, to);
      } else if (url === "/api/withdraw") {
        // two withdrawals share this button: pull what the program owes you,
        // then move SOL out of the custodial wallet
        const owed = await ctx.chain.creditOf(me);
        if (owed > 0n) { sig = await keeper.withdraw(); ctx.store.logTx("claim", sig, true); }
        if (p.to !== undefined && p.to !== "") {
          const to = parsePubkey(p.to);
          const amount = p.lamports === "max" || p.lamports === undefined ? "max" as const : parseLamports(p.lamports);
          kind = "payout"; sig = await keeper.sendSol(to, amount);
        } else if (owed === 0n) throw new HttpError(400, "nothing to withdraw");
        else kind = "claim";
      } else {
        throw new HttpError(404, "no such route");
      }
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      const name = ctx.chain.errorName(e);
      ctx.store.logTx(kind || url.slice(5), e?.signature ?? "", false, id);
      throw new HttpError(name === "WrongPrice" ? 409 : 400, name ? `${name}: ${friendly(name)}` : String(e?.message ?? e).slice(0, 200));
    }
    if (kind !== "claim") ctx.store.logTx(kind, sig, true, id);
    // the UI reads the new state straight after this returns, so refresh the
    // chain cache now rather than leaving it a poll behind
    await ctx.refreshChain().catch(() => undefined);
    ctx.store.persist();
    return { ok: true, sig, explorer: ctx.chain.explorerTx(sig) };
  }

  function friendly(name: string) {
    return ({
      WrongStatus: "the fly is not in a state that allows this", NotForSale: "not for sale",
      WrongPrice: "the price changed — look again", NotOwner: "not yours", WrongId: "no such fly",
      AssetMismatch: "that NFT is not this fly's", WrongCollection: "that NFT is not from this world",
      InsufficientFunds: "not enough SOL in your wallet to pay for this",
      WindingDown: "the world is winding down; no new life is sold or rewarded",
      RecoveryIsOperator: "the recovery address must not be the operator",
    } as Record<string, string>)[name] ?? name;
  }

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "/";
    const origin = req.headers.origin;
    if (origin && ctx.corsOrigin && origin === ctx.corsOrigin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-headers", "content-type, authorization");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      res.setHeader("vary", "origin");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    // link previewers and monitors ask HEAD before GET: answer like GET (Node
    // drops the body itself), except the two routes that would stream
    const head = req.method === "HEAD";
    if (head && /^\/api\/(stream|snapshot)(\?|$)/.test(url)) { res.writeHead(405); res.end(); return; }
    const json = (status: number, body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" || head) {
        const route = url.split("?")[0];
        if (route === "/api/journal") return json(200, journalView());
        if (route === "/api/config") {
          return json(200, {
            cluster: ctx.cluster, googleClientId: ctx.googleClientId, programId: ctx.chain.programId.toBase58(),
            publicUrl: ctx.publicUrl, coin: ctx.coin, build: ctx.build, economy: ctx.economy,
            worldPda: ctx.chain.worldPda.toBase58(), collection: ctx.world()?.collection.toBase58() ?? null,
            explorer: "https://explorer.solana.com", explorerQuery: ctx.chain.explorerQuery,
            // The PUBLIC endpoint, never the configured one: that may carry a
            // provider key, and this payload is served to every visitor.
            rpc: PUBLIC_RPC[ctx.cluster],
            tickrate: ctx.store.journal.tickrate, epochInterval: ctx.store.journal.epochInterval,
            // where a mirror reads the epoch commitment in the raw World
            // account, so VERIFIED means the chain agrees, not this server
            world: ctx.chain.worldLayout,
            // the brain and the cage the site draws: every neuron of the
            // MaleCNS connectome, every connection of five or more synapses
            nodes: ctx.engine.nodeCount, edges: ctx.engine.edgeCount, roleCounts: roleCountsOf(ctx.engine),
            groups: ROLE_GROUPS, arena: ctx.arena,
          });
        }
        if (route === "/api/collection.json") {
          // the Collection asset's metadata: what wallets show for the set
          res.setHeader("cache-control", "public, max-age=3600");
          return json(200, {
            name: "Instar", symbol: "INSTAR",
            description: "Instar: a cage of adult male Drosophila melanogaster, each run on every neuron of the Janelia MaleCNS v1.0 connectome and every connection of five or more synapses. " +
              "Every fly is one asset in this collection; its owner is its keeper, and the asset is burned when it dies.",
            image: `${ctx.publicUrl}/icon-512.png`,
            external_url: `${ctx.publicUrl}/`,
            properties: { files: [{ uri: `${ctx.publicUrl}/icon-512.png`, type: "image/png" }, { uri: `${ctx.publicUrl}/mark.svg`, type: "image/svg+xml" }], category: "image" },
          });
        }
        if (route === "/api/state") {
          const e = ctx.engine;
          const alive = e.alive, pose = e.pose;
          let flying = 0, walking = 0;
          for (let s = 0; s < e.maxPop; s++) if (alive[s]) { if (pose[s * e.poseLen + POSE.MODE]) flying++; else walking++; }
          return json(200, {
            tick: ctx.tick(), population: e.popCount, flying, walking, maxGen: e.maxGeneration, capacity: ctx.capacity(),
            epoch: ctx.lastEpoch(), light: e.light, temp: e.temp, pendingOps: ctx.ops.length,
          });
        }
        if (route === "/api/stream") return openStream(req, res);
        if (route === "/api/health") {
          const h = await health();
          res.setHeader("cache-control", "no-cache");
          return json(h.ok ? 200 : 503, h);
        }
        if (route === "/api/backup") {
          // the operator's off-host copy of the record: the whole custody
          // file is in it, so the token gate is the only thing between it
          // and the internet. Unset token: the route does not exist.
          if (!ctx.adminToken) return json(404, { error: "no such route" });
          // the token gates every keeper's sealed key: bearer header only, never a query string a log could keep
          if (!adminAuthorized(bearer(req))) return json(403, { error: "forbidden" });
          const tgz = await backupArchive();
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
          res.setHeader("content-type", "application/gzip");
          res.setHeader("content-disposition", `attachment; filename="instar-${ctx.cluster}-${stamp}.tgz"`);
          res.setHeader("cache-control", "no-store");
          res.writeHead(200);
          res.end(tgz);
          ctx.log(`backup served (${(tgz.length / 1e6).toFixed(2)} MB) to ${clientIp(req)}`);
          return;
        }
        if (route === "/api/idl") {
          // the program's IDL, for a wallet or a mirror that builds its own
          // transactions against this world; short-lived so a program
          // rotation reaches open pages within a minute
          res.setHeader("cache-control", "public, max-age=60");
          res.setHeader("content-type", "application/json");
          res.writeHead(200);
          res.end(idlJson);
          return;
        }
        if (route === "/api/snapshot") {
          // The verifiers' starting point, streamed: the newest image on
          // disk (the five-minute one or the latest pre-boundary one), or
          // with ?epoch=N the retained pre-boundary image of that epoch. The
          // public route never triggers a copy or a gzip; only the admin
          // token asks for a fresh five-minute image, as /api/backup does.
          const params = new URL(url, "http://x").searchParams;
          let file: string;
          if (params.has("epoch")) {
            const epoch = Number(params.get("epoch"));
            const f = Number.isInteger(epoch) ? ctx.snapshotEpochFile(epoch) : null;
            if (!f) return json(404, { error: `no image retained for epoch ${params.get("epoch")}; retained: ${ctx.snapshotEpochs().join(", ") || "none"}` });
            file = f;
          } else if (adminAuthorized(bearer(req))) {
            file = await ctx.snapshotFile(SNAPSHOT_REFRESH_MS);
          } else {
            file = await ctx.latestSnapshotFile();
          }
          res.setHeader("content-type", "application/octet-stream");
          res.setHeader("content-encoding", "gzip");
          res.setHeader("cache-control", "no-cache");
          res.setHeader("content-length", String(fs.statSync(file).size));
          res.writeHead(200);
          fs.createReadStream(file).pipe(res);
          return;
        }
        const fired = /^\/api\/fly\/(\d+)\/fired$/.exec(route);
        if (fired) {
          // the brain window's raster: bit k = fired flag of node k*stride at
          // the latest tick, LSB first, for a fly that is alive right now
          const eng = ctx.engineFly(Number(fired[1]));
          if (!eng) return json(404, { error: `fly ${fired[1]} is not in the cage` });
          const stride = Number(new URL(url, "http://x").searchParams.get("stride") ?? 4);
          if (!Number.isInteger(stride) || stride < 1 || stride > FIRED_STRIDE_MAX) return json(400, { error: `stride must be 1..${FIRED_STRIDE_MAX}` });
          const flags = ctx.engine.firedOf(eng.slot);
          const n = Math.ceil(flags.length / stride);
          const bits = Buffer.alloc(Math.ceil(n / 8));
          for (let k = 0; k < n; k++) if (flags[k * stride]) bits[k >> 3] |= 1 << (k & 7);
          res.setHeader("content-type", "application/octet-stream");
          res.setHeader("cache-control", "no-cache");
          res.writeHead(200);
          res.end(bits);
          return;
        }
        const fly = /^\/api\/fly\/(\d+)\.(svg|json)$/.exec(route);
        if (fly) {
          const id = Number(fly[1]);
          const c = ctx.flies().find(x => x.id === id);
          const eng = ctx.engineFly(id);
          if (!c && !eng) return json(404, { error: `no fly ${id}` });
          const generation = c?.generation ?? eng!.generation;
          const genomeHash = c && /[1-9a-f]/.test(c.genomeHash) ? c.genomeHash : eng?.genomeHash ?? c!.genomeHash;
          const status = c ? STATUS_NAME[c.status] : "unregistered";
          res.setHeader("cache-control", "public, max-age=60");
          if (fly[2] === "svg") {
            res.setHeader("content-type", "image/svg+xml");
            res.writeHead(200);
            res.end(flySvg({ id, genomeHash, generation, status }));
            return;
          }
          const image = `${ctx.publicUrl}/api/fly/${id}.svg`;
          const parentId = c ? c.parentId : ctx.store.journal.parents[id] ?? -1;
          // `name` matches the on-chain asset the program mints (Instar #id);
          // the description is where the animal is named
          return json(200, {
            name: `Instar #${id}`, symbol: "INSTAR",
            description: `Instar fly #${id}: an adult male Drosophila melanogaster in the Instar cage, driven by every neuron of the Janelia MaleCNS v1.0 connectome and every connection of five or more synapses. Generation ${generation}. Status: ${status}.`,
            image,
            external_url: `${ctx.publicUrl}/cage.html#fly=${id}`,
            attributes: [
              { trait_type: "Generation", value: generation },
              { trait_type: "Status", value: status },
              { trait_type: "Parent", value: parentId >= 0 ? parentId : "founder" },
              ...(c ? [{ trait_type: "Birth tick", value: c.birthTick }] : []),
              { trait_type: "Genome hash", value: genomeHash },
              { trait_type: "Species", value: "Drosophila melanogaster (adult male)" },
            ],
            properties: { files: [{ uri: image, type: "image/svg+xml" }], category: "image" },
          });
        }
        if (route.startsWith("/api/")) return json(404, { error: "no such route" });
        if (serveStatic(ctx, url, res)) return;
        return json(404, { error: "not found" });
      }
      if (req.method === "POST") {
        if (!url.startsWith("/api/")) return json(404, { error: "no such route" });
        return json(200, await post(url.split("?")[0], req));
      }
      json(405, { error: "method not allowed" });
    } catch (e: any) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      let msg = String(e?.message ?? e);
      // "Unsupported state or unable to authenticate data" is what AES-GCM
      // says when a record was sealed under a different key. True, and
      // useless to whoever is trying to sign in.
      if (/Unsupported state|unable to authenticate data/i.test(msg)) {
        msg = "this account could not be opened by this world";
        ctx.log("account decrypt failed at request time: " + String(e?.message ?? e));
      }
      json(400, { error: msg.slice(0, 200) });
    }
  };
}
