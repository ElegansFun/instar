// The world's HTTP face: the journal for mirrors, the market for keepers,
// the static site. Every trade below is signed by the keeper's own custodial
// key; the operator never buys, sells or moves a larva on anyone's behalf.

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as zlib from "zlib";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Chain, PUBLIC_RPC, STATUS, STATUS_NAME, formatSol, loadIdl, type CreatureView, type WorldView, type Cluster } from "../chain/solana.mts";
import { Accounts } from "./accounts.mts";
import { BACKUP_FILES, gzipArchive, type Entry as ArchiveEntry } from "./archive.mts";
import { Engine } from "./engine.mts";
import { JournalStore, type LineageName } from "./journal.mts";
import { OpQueue } from "./ops.mts";
import { larvaSvg } from "./art.mts";

export type WorldContext = {
  cluster: Cluster;
  googleClientId: string;
  publicUrl: string;
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
  larvae(): CreatureView[];
  world(): WorldView | null;
  refreshChain(): Promise<void>;
  snapshotMeta(): Record<string, unknown>;
  /// the snapshot file's bytes as saveSnapshot would write them now
  snapshotBytes(): Buffer;
  /// what the engine knows about a larva that may not be on chain yet
  engineLarva(id: number): { generation: number; lineage: number; genomeHash: string } | null;
  log(line: string): void;
};

/// What the server knows before the world is built. The port is bound
/// first so a supervisor sees `replaying` (503) instead of a refused
/// connection while the journal replays; `ctx` is set once the world is live.
export type Boot = { ctx: WorldContext | null; tick: number; target: number };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".cbg": "application/octet-stream",
};
const BODY_LIMIT = 64 * 1024;
const AUTH_RATE = { max: 5, windowMs: 60_000 };
/// Behind a reverse proxy the socket address is the proxy's; set
/// INSTAR_TRUST_PROXY=1 to key the rate limit on the LAST X-Forwarded-For
/// element (the one the proxy itself appended; earlier ones are client-supplied).
const TRUST_PROXY = process.env.INSTAR_TRUST_PROXY === "1";
const AIRDROP_LAMPORTS = BigInt(LAMPORTS_PER_SOL);
const SNAPSHOT_CACHE_MS = 5000;
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

function larvaJson(c: CreatureView) {
  return {
    id: c.id, asset: c.asset.toBase58(), keeper: c.keeper.toBase58(), status: c.status, statusName: STATUS_NAME[c.status],
    vault: lamports(c.vault), salePrice: lamports(c.salePrice), listedBy: c.listedBy.toBase58(), listedAt: c.listedAt, generation: c.generation,
    parentId: c.parentId, pendingCull: c.pendingCull, birthTick: c.birthTick, deathTick: c.deathTick,
    genomeHash: c.genomeHash,
  };
}

export function createServer(boot: Boot): http.Server {
  let live: ReturnType<typeof handler> | null = null;
  return http.createServer((req, res) => {
    if (boot.ctx) {
      live ??= handler(boot.ctx);
      return live(req, res);
    }
    const route = (req.url ?? "/").split("?")[0];
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
  let snapCache: { gz: Buffer; at: number } | null = null;
  const idlJson = JSON.stringify(loadIdl());

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

  /// The same archive scripts/backup.mts makes, from the live objects: the
  /// snapshot is taken first and the journal right after, in one turn of
  /// the event loop, so the pair is consistent and resumes rather than
  /// replays. The .bak files, genesis.lock and the quarantine file have no
  /// live object and come from the disk.
  const backupArchive = (): Buffer => {
    const now = Date.now();
    const { accounts, sessions } = ctx.accounts.serialize();
    const liveEntries: Record<string, Buffer> = {
      "snapshot.bin": ctx.snapshotBytes(),
      "journal.json": Buffer.from(JSON.stringify(ctx.store.journal)),
      "accounts.json": Buffer.from(accounts),
      "sessions.json": Buffer.from(sessions),
    };
    const entries: ArchiveEntry[] = [];
    for (const name of BACKUP_FILES) {
      if (liveEntries[name]) { entries.push({ name, data: liveEntries[name], mtime: now }); continue; }
      const file = path.join(ctx.dataDir, name);
      if (!fs.existsSync(file)) continue;
      entries.push({ name, data: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs });
    }
    return gzipArchive(entries);
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
      larvae: ctx.larvae().map(larvaJson),
      metabolism: lamports(w?.metabolism ?? 0n), pool: lamports(w?.pool ?? 0n),
      operator: ctx.chain.operator.publicKey.toBase58(), operatorBalance: lamports(ctx.ops.operatorBalance),
      pendingOps: ctx.ops.length,
      // The site says every event is a transaction. When the operator cannot
      // pay, that stops being true until it is funded, and the page should
      // say so rather than quietly showing a stale world.
      settling: !ctx.ops.outOfGas,
      journalOk: !ctx.store.persistFailed,
      txlog: j.txlog.slice(-200), lineageNames: j.lineageNames,
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

  const larvaById = (id: number) => {
    const c = ctx.larvae().find(x => x.id === id);
    if (!c) throw new HttpError(404, `no larva ${id}`);
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

    const who = ctx.accounts.sessionUser(bearer(req));
    if (!who) throw new HttpError(401, "not signed in");
    const keypair = ctx.accounts.keypair(who);
    const me = keypair.publicKey;

    if (url === "/api/me") {
      const [balance, credit] = await Promise.all([ctx.chain.balance(me), ctx.chain.creditOf(me)]);
      const owned = ctx.larvae().filter(c => c.status === STATUS.OWNED && c.keeper.equals(me)).map(c => c.id);
      return { ...ctx.accounts.profile(who), wallet: me.toBase58(), balance: lamports(balance), credit: lamports(credit), owned };
    }

    if (url === "/api/name-lineage") {
      // Naming a bloodline is a claim on the record, not a chain action — it
      // costs nothing and lives in the journal beside the lineage. The claim
      // belongs to whoever keeps a living larva of that line.
      const id = parseId(p.id);
      const name = String(p.name ?? "").trim().slice(0, 32);
      if (name.length < 2) throw new HttpError(400, "name it something (2-32 characters)");
      const c = larvaById(id);
      if (!c.keeper.equals(me) || c.status !== STATUS.OWNED) throw new HttpError(403, "not yours");
      const eng = ctx.engineLarva(id);
      if (!eng) throw new HttpError(409, `#${id} is not on the plate right now`);
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
      if (held >= AIRDROP_LAMPORTS) return { ok: true, funded: false, note: "already funded", balance: lamports(held) };
      let sig: string;
      try {
        sig = await ctx.chain.airdrop(me, AIRDROP_LAMPORTS);
        ctx.store.logTx("airdrop", sig, true);
      } catch (e: any) {
        if (ctx.cluster !== "localnet") throw new HttpError(503, `airdrop refused by the RPC (${String(e?.message ?? e).slice(0, 80)}) — try https://faucet.solana.com`);
        sig = await ctx.chain.sendFromOperator(me, AIRDROP_LAMPORTS - held);
        ctx.store.logTx("airdrop", sig, true);
      }
      ctx.store.persist();
      return { ok: true, funded: true, sig, explorer: ctx.chain.explorerTx(sig), balance: lamports(await ctx.chain.balance(me)) };
    }

    const keeper = ctx.chain.asKeeper(keypair);
    const mine = (id: number) => {
      const c = larvaById(id);
      if (!c.keeper.equals(me) || c.status !== STATUS.OWNED) throw new HttpError(403, "not yours");
      return c;
    };
    let sig = "", kind = "";
    let id: number | undefined;
    try {
      if (url === "/api/buy") {
        id = parseId(p.id);
        const c = larvaById(id);
        if (c.status !== STATUS.OFFERED) throw new HttpError(409, "not offered");
        // the buyer pays the price they were shown, not whatever the seller
        // has changed it to since: the program refuses a mismatch (WrongPrice)
        kind = "buy"; sig = await keeper.buy(id, p.lamports === undefined ? c.salePrice : parseLamports(p.lamports));
      } else if (url === "/api/buylisted") {
        id = parseId(p.id);
        const c = larvaById(id);
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
      WrongStatus: "the larva is not in a state that allows this", NotForSale: "not for sale",
      WrongPrice: "the price changed — look again", NotOwner: "not yours", WrongId: "no such larva",
      AssetMismatch: "that NFT is not this larva's", WrongCollection: "that NFT is not from this world",
      InsufficientFunds: "not enough SOL in your wallet to pay for this",
      WindingDown: "the world is winding down; no new life is sold or rewarded",
      RecoveryIsOperator: "the recovery address must not be the operator",
    } as Record<string, string>)[name] ?? name;
  }

  function serveStatic(url: string, res: http.ServerResponse): boolean {
    let rel: string;
    try { rel = decodeURIComponent(url.split("?")[0]); } catch { return false; }
    if (rel === "/") rel = "/index.html";
    if (rel.includes("\0")) return false;
    const isData = rel.startsWith("/data/canonical/");
    const base = isData ? path.join(ctx.rootDir, "data", "canonical") : ctx.siteDir;
    const full = path.resolve(base, "." + (isData ? rel.slice("/data/canonical".length) : rel));
    if (full !== base && !full.startsWith(base + path.sep)) return false;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
    res.setHeader("content-type", MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("cache-control", isData ? "public, max-age=3600" : "no-cache");
    res.setHeader("x-frame-options", "DENY");
    res.writeHead(200);
    res.end(fs.readFileSync(full));
    return true;
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
    const json = (status: number, body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET") {
        const route = url.split("?")[0];
        if (route === "/api/journal") return json(200, journalView());
        if (route === "/api/config") {
          return json(200, {
            cluster: ctx.cluster, googleClientId: ctx.googleClientId, programId: ctx.chain.programId.toBase58(),
            worldPda: ctx.chain.worldPda.toBase58(), collection: ctx.world()?.collection.toBase58() ?? null,
            explorer: "https://explorer.solana.com", explorerQuery: ctx.chain.explorerQuery,
            // The PUBLIC endpoint, never the configured one: that may carry a
            // provider key, and this payload is served to every visitor.
            rpc: PUBLIC_RPC[ctx.cluster],
            tickrate: ctx.store.journal.tickrate, epochInterval: ctx.store.journal.epochInterval,
            // where a mirror reads the epoch commitment in the raw World
            // account, so VERIFIED means the chain agrees, not this server
            world: ctx.chain.worldLayout,
          });
        }
        if (route === "/api/collection.json") {
          // the Collection asset's metadata: what wallets show for the set
          res.setHeader("cache-control", "public, max-age=3600");
          return json(200, {
            name: "Instar", symbol: "INSTAR",
            description: "Instar: a dish of Drosophila melanogaster first-instar larvae, each run on the Winding et al. 2023 larval connectome. " +
              "Every larva is one asset in this collection; its owner is its keeper, and the asset is burned when it dies.",
            image: `${ctx.publicUrl}/mark.svg`,
            external_url: `${ctx.publicUrl}/`,
            properties: { files: [{ uri: `${ctx.publicUrl}/mark.svg`, type: "image/svg+xml" }], category: "image" },
          });
        }
        if (route === "/api/state") {
          const e = ctx.engine;
          return json(200, {
            tick: ctx.tick(), population: e.popCount, maxGen: e.maxGeneration, capacity: ctx.capacity(),
            epoch: ctx.lastEpoch(), light: e.sim.light_now(), temp: e.sim.temp_now(), pendingOps: ctx.ops.length,
          });
        }
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
          const q = new URL(url, "http://x").searchParams.get("token") ?? undefined;
          if (!adminAuthorized(q ?? bearer(req))) return json(403, { error: "forbidden" });
          const tgz = backupArchive();
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
          // join the world instantly instead of replaying it
          const now = Date.now();
          if (!snapCache || now - snapCache.at > SNAPSHOT_CACHE_MS) {
            const meta = Buffer.from(JSON.stringify(ctx.snapshotMeta()));
            const len = Buffer.alloc(4); len.writeUInt32LE(meta.length, 0);
            snapCache = { gz: zlib.gzipSync(Buffer.concat([len, meta, ctx.engine.snapshot()]), { level: 6 }), at: now };
          }
          res.setHeader("content-type", "application/octet-stream");
          res.setHeader("content-encoding", "gzip");
          res.setHeader("cache-control", "no-cache");
          res.writeHead(200);
          res.end(snapCache.gz);
          return;
        }
        const larva = /^\/api\/larva\/(\d+)\.(svg|json)$/.exec(route);
        if (larva) {
          const id = Number(larva[1]);
          const c = ctx.larvae().find(x => x.id === id);
          const eng = ctx.engineLarva(id);
          if (!c && !eng) return json(404, { error: `no larva ${id}` });
          const generation = c?.generation ?? eng!.generation;
          const genomeHash = c && /[1-9a-f]/.test(c.genomeHash) ? c.genomeHash : eng?.genomeHash ?? c!.genomeHash;
          const status = c ? STATUS_NAME[c.status] : "unregistered";
          res.setHeader("cache-control", "public, max-age=60");
          if (larva[2] === "svg") {
            res.setHeader("content-type", "image/svg+xml");
            res.writeHead(200);
            res.end(larvaSvg({ id, genomeHash, generation, status }));
            return;
          }
          const image = `${ctx.publicUrl}/api/larva/${id}.svg`;
          const parentId = c ? c.parentId : ctx.store.journal.parents[id] ?? -1;
          return json(200, {
            name: `Instar #${id}`, symbol: "INSTAR",
            description: `A Drosophila melanogaster first-instar larva in the Instar world, driven by the Winding et al. 2023 larval connectome. Generation ${generation}. Status: ${status}.`,
            image,
            external_url: `${ctx.publicUrl}/dish.html#larva=${id}`,
            attributes: [
              { trait_type: "Generation", value: generation },
              { trait_type: "Status", value: status },
              { trait_type: "Parent", value: parentId >= 0 ? parentId : "founder" },
              ...(c ? [{ trait_type: "Birth tick", value: c.birthTick }] : []),
              { trait_type: "Genome hash", value: genomeHash },
              { trait_type: "Species", value: "Drosophila melanogaster (L1)" },
            ],
            properties: { files: [{ uri: image, type: "image/svg+xml" }], category: "image" },
          });
        }
        if (route.startsWith("/api/")) return json(404, { error: "no such route" });
        if (serveStatic(url, res)) return;
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
