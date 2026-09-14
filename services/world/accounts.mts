// Custodial accounts: signing in makes you a Solana keypair, held here so
// nobody needs a wallet extension. The secret key is sealed with AES-256-GCM
// under the world's master key; the PIN is scrypt-hashed and never stored.
// The site says so in plain words: custodial by design.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readJsonWithBackup, writeAtomic } from "./journal.mts";

type Enc = { iv: string; tag: string; ct: string };
export type Account = { pinSalt: string; pinHash: string; enc: Enc; email?: string; name?: string; created: number };

export type Session = { user: string; exp: number };

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const USER_RE = /^[a-z0-9_.-]{3,24}$/;
const NO_MATCH = "no account matches that name and pin — tick 'create' to make one";

/// Without INSTAR_MASTER_KEY the custody key is derived from the operator
/// key. That key is hot and gets rotated, which would lock every keeper out:
/// a localnet/devnet convenience only (index.mts refuses it on mainnet).
export function deriveMasterKey(operatorSecret: Uint8Array): Buffer {
  return crypto.createHash("sha256").update(Buffer.concat([operatorSecret, Buffer.from("|instar-custody-v1")])).digest();
}

/// Re-seal every custodial key in `dir`/accounts.json under `next`. The
/// world must be stopped: it holds the file in memory and would write the
/// old sealing back over this. Every record is opened before any is
/// written, so a wrong `current` changes nothing. Returns how many.
export function resealAccounts(dir: string, current: Buffer, next: Buffer): number {
  const file = path.join(dir, "accounts.json");
  const accounts: Record<string, Account> = JSON.parse(fs.readFileSync(file, "utf8"));
  const resealed: Record<string, Account> = {};
  for (const [user, a] of Object.entries(accounts)) {
    let secret: Buffer;
    try { secret = decrypt(current, a.enc); } catch { throw new Error(`${user}: cannot be opened with the current key — is INSTAR_MASTER_KEY the one the world runs with? Nothing was written`); }
    if (secret.length !== 64) throw new Error(`${user}: sealed secret is ${secret.length} bytes, not a keypair`);
    resealed[user] = { ...a, enc: encrypt(next, secret) };
  }
  const json = JSON.stringify(resealed);
  writeAtomic(file, json);
  // writeAtomic just pushed the old-key ciphertext into .bak; a rotation done
  // because that key may have leaked must leave nothing sealed under it
  writeAtomic(file + ".bak", json);
  fs.rmSync(file + ".bak.bak", { force: true });
  return Object.keys(resealed).length;
}

/// Every custodial keypair in `dir`/accounts.json under `key`, read-only
/// (no quarantine, nothing written). A record this key cannot open comes
/// back with `keypair: null` so the caller can say so by name.
export function custodialKeypairs(dir: string, key: Buffer): { user: string; keypair: Keypair | null }[] {
  const file = path.join(dir, "accounts.json");
  const accounts: Record<string, Account> = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.entries(accounts).map(([user, a]) => {
    try {
      const secret = decrypt(key, a.enc);
      return { user, keypair: secret.length === 64 ? Keypair.fromSecretKey(secret) : null };
    } catch { return { user, keypair: null }; }
  });
}

function encrypt(key: Buffer, secret: Uint8Array): Enc {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

function decrypt(key: Buffer, e: Enc): Buffer {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "hex"));
  d.setAuthTag(Buffer.from(e.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(e.ct, "hex")), d.final()]);
}

export class Accounts {
  private readonly accountsPath: string;
  private readonly sessionsPath: string;
  private readonly masterKey: Buffer;
  private readonly accounts: Record<string, Account>;
  private readonly sessions = new Map<string, Session>();
  /// wrong-pin counts per username; in memory, a restart forgives
  private readonly lockouts = new Map<string, { fails: number; until: number }>();
  /// names whose records were quarantined: never re-minted over
  private readonly reserved = new Set<string>();
  /// wallet address -> public handle, for the journal's lineage credits
  readonly handles: Record<string, string> = {};
  private readonly log: (l: string) => void;

  constructor(opts: { dir: string; masterKey: Buffer; log: (l: string) => void }) {
    if (opts.masterKey.length !== 32) throw new Error("master key must be 32 bytes");
    this.accountsPath = path.join(opts.dir, "accounts.json");
    this.sessionsPath = path.join(opts.dir, "sessions.json");
    this.masterKey = opts.masterKey;
    this.log = opts.log;
    this.accounts = this.load();
    this.quarantineUnreadable();
    for (const u of Object.keys(this.accounts)) this.handles[this.keypair(u).publicKey.toBase58()] = publicHandle(u, this.accounts[u]);
    this.loadSessions();
  }

  // ---- storage --------------------------------------------------------------

  /// This file is the only copy of every keeper's custodial key. Never start
  /// with an EMPTY set because the current file failed to parse — that would
  /// mint fresh wallets over the top of real ones. Try the backup, and refuse
  /// to boot rather than silently orphan them.
  private load(): Record<string, Account> {
    if (!fs.existsSync(this.accountsPath)) return {};
    const v = readJsonWithBackup<Record<string, Account>>(this.accountsPath, this.log);
    if (v) return v;
    throw new Error(
      "accounts.json and its backup are both unreadable. Starting with an empty set would mint new " +
      "wallets over real keepers' existing ones and orphan their flies and balances. Restore the file."
    );
  }

  private save() {
    writeAtomic(this.accountsPath, JSON.stringify(this.accounts));
  }

  /// The two files exactly as save() would write them now, for a backup
  /// taken from the live process rather than from the disk.
  serialize(): { accounts: string; sessions: string } {
    return { accounts: JSON.stringify(this.accounts), sessions: JSON.stringify(Object.fromEntries(this.sessions)) };
  }

  /// Records sealed under a different master key cannot be opened here, and
  /// the failure would otherwise surface mid sign-in as an AES error that
  /// tells the person nothing. Move them aside at boot; the file is kept —
  /// it is somebody's record even if this world cannot read it.
  private quarantineUnreadable() {
    const stale = Object.entries(this.accounts).filter(([, a]) => !this.usable(a));
    if (!stale.length) return;
    // every record unreadable is the master key, not the records: a world
    // that booted anyway would mint fresh wallets over real ones
    if (stale.length === Object.keys(this.accounts).length) throw new Error(`none of the ${stale.length} custodial account(s) decrypt under this master key; INSTAR_MASTER_KEY is wrong for this data directory`);
    const aside = this.accountsPath + ".unreadable.json";
    let prior: Record<string, Account> = {};
    try { prior = JSON.parse(fs.readFileSync(aside, "utf8")); } catch { /* first quarantine */ }
    for (const [k, v] of stale) { prior[k] = v; delete this.accounts[k]; this.reserved.add(k); }
    fs.writeFileSync(aside, JSON.stringify(prior));
    this.save();
    this.log(`${stale.length} account(s) could not be decrypted by this world — moved to ${path.basename(aside)}; their names are reserved`);
  }

  private usable(a: Account): boolean {
    try {
      return this.decrypt(a.enc).length === 64;
    } catch {
      return false;
    }
  }

  private encrypt(secret: Uint8Array): Enc {
    return encrypt(this.masterKey, secret);
  }

  private decrypt(e: Enc): Buffer {
    return decrypt(this.masterKey, e);
  }

  // ---- identity -------------------------------------------------------------

  keypair(user: string): Keypair {
    const a = this.accounts[user];
    if (!a) throw new Error("no such account");
    return Keypair.fromSecretKey(this.decrypt(a.enc));
  }

  address(user: string): PublicKey {
    return this.keypair(user).publicKey;
  }

  profile(user: string) {
    const a = this.accounts[user];
    return { user, name: a?.name, email: a?.email, handle: publicHandle(user, a) };
  }

  private create(user: string, extra: Partial<Account>): Account {
    const kp = Keypair.generate();
    const a: Account = { pinSalt: "", pinHash: "", enc: this.encrypt(kp.secretKey), created: Date.now(), ...extra };
    this.accounts[user] = a;
    this.save();
    this.handles[kp.publicKey.toBase58()] = publicHandle(user, a);
    return a;
  }

  /// Username + PIN. Creating requires the caller to say so: a typo in a
  /// username must not quietly become a new empty wallet. A wrong pin and
  /// an unknown name fail with the same words, so nobody can list who has
  /// an account by trying names.
  signIn(userRaw: string, pin: string, create: boolean): string {
    const user = String(userRaw || "").trim().toLowerCase();
    if (!USER_RE.test(user)) throw new Error("username: 3-24 characters, a-z 0-9 _ . -");
    if (typeof pin !== "string" || pin.length < 6 || pin.length > 64) throw new Error("pin: 6-64 characters");
    if (user.startsWith("g:")) throw new Error("that name is reserved");
    const existing = this.accounts[user];
    if (existing) {
      if (!existing.pinSalt) throw new Error("this account signs in with Google");
      // wrong pins back off per account: the IP limiter alone is beaten by
      // spreading guesses, and usernames are public on the journal
      const lock = this.lockouts.get(user);
      if (lock && lock.until > Date.now()) throw new Error(`too many wrong pins; try again in ${Math.ceil((lock.until - Date.now()) / 1000)} s`);
      if (!timingSafeEq(hashPin(pin, existing.pinSalt), existing.pinHash)) {
        const fails = (lock?.fails ?? 0) + 1;
        const until = fails >= 5 ? Date.now() + Math.min(600_000, 30_000 * 2 ** (fails - 5)) : 0;
        this.lockouts.set(user, { fails, until });
        if (until) this.log(`sign-in locked for ${user}: ${fails} wrong pins`);
        throw new Error(NO_MATCH);
      }
      this.lockouts.delete(user);
    } else {
      if (!create || this.reserved.has(user)) throw new Error(NO_MATCH);
      const salt = crypto.randomBytes(16).toString("hex");
      this.create(user, { pinSalt: salt, pinHash: hashPin(pin, salt) });
      this.log(`account created: ${user}`);
    }
    return this.openSession(user);
  }

  /// Google sign-in: the browser gets an ID token from Google and posts it
  /// here; we verify it with Google directly rather than trusting the page.
  /// `aud` is the check that stops a token minted for somebody else's app
  /// being replayed at ours.
  async signInGoogle(credential: string, clientId: string): Promise<string> {
    if (!clientId) throw new Error("google sign-in is not configured on this world");
    if (!credential) throw new Error("missing credential");
    const info: any = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential))
      .then(r => r.json()).catch(() => null);
    if (!info || info.aud !== clientId) throw new Error("invalid google token");
    if (info.iss !== "accounts.google.com" && info.iss !== "https://accounts.google.com") throw new Error("bad issuer");
    if (info.email_verified !== "true" && info.email_verified !== true) throw new Error("email not verified");
    const user = "g:" + info.sub;
    if (!this.accounts[user]) {
      this.create(user, { email: info.email, name: info.name });
      this.log(`google account created: ${info.email}`);
    }
    return this.openSession(user);
  }

  // ---- sessions -------------------------------------------------------------

  private loadSessions() {
    let saved: Record<string, Session> = {};
    try { saved = JSON.parse(fs.readFileSync(this.sessionsPath, "utf8")); } catch { /* none yet */ }
    const now = Date.now();
    for (const [t, s] of Object.entries(saved)) if (s.exp > now && this.accounts[s.user]) this.sessions.set(t, s);
  }

  private saveSessions() {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.exp < now) this.sessions.delete(t);
    writeAtomic(this.sessionsPath, JSON.stringify(Object.fromEntries(this.sessions)));
  }

  /// Sessions are keyed by the sha-256 of the bearer, so the file on disk
  /// (and any backup of it) holds nothing a client could present.
  private static key(token: string) { return crypto.createHash("sha256").update(token).digest("hex"); }

  private openSession(user: string): string {
    const token = crypto.randomBytes(24).toString("hex");
    this.sessions.set(Accounts.key(token), { user, exp: Date.now() + SESSION_TTL_MS });
    this.saveSessions();
    return token;
  }

  sessionUser(token: string | undefined): string | null {
    const s = token ? this.sessions.get(Accounts.key(token)) : undefined;
    if (!s || s.exp < Date.now()) return null;
    return s.user;
  }

  closeSession(token: string | undefined) {
    if (token && this.sessions.delete(Accounts.key(token))) this.saveSessions();
  }
}

function hashPin(pin: string, salt: string) {
  return crypto.scryptSync(pin, salt, 32).toString("hex");
}

function timingSafeEq(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function publicHandle(user: string, a?: Account) {
  return user.startsWith("g:") ? (a?.name || "keeper").split(/\s+/)[0].toLowerCase().slice(0, 16) : user;
}
