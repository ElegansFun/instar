// chain.js: the wallet path's transaction builders. Discriminators, argument
// layouts, account order and flags come from the world's IDL (/api/idl), but
// the program itself is pinned here: the page refuses to build against any
// other program id, derives the world PDA itself, and remembers the identity
// it first saw so a swap between visits is never silent. The page builds the
// instruction, the visitor's own wallet signs it, and the RPC named in
// /api/config (with public fallbacks) carries it; the world process is never
// in the loop. Uses the vendored @solana/web3.js classic build
// (window.solanaWeb3) for keys, transactions and the RPC.
import { API } from "./engine.js";

// The one program this page signs for. scripts/preflight.mts asserts it
// equals the IDL's address, so a key rotation cannot ship a mismatched site.
export const PROGRAM_ID = "A42YLDRf1WoVVzrkPpkGnvsKpJiN4oZCjHEvo4iMt6Tu";
export const MPL_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
// Public endpoints tried, in order, after the one the world names.
const PUBLIC_RPC = {
  localnet: ["http://127.0.0.1:8899", "http://localhost:8899"],
  devnet: ["https://api.devnet.solana.com"],
  "mainnet-beta": ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
};
// Compute-unit limits per instruction, the service's table (solana.mts CU):
// Core CPIs (transfer, freeze) get 200k, a plain program instruction 50k.
const UNITS = { buy: 200_000, buy_listed: 200_000, request_cull: 200_000, list: 50_000, unlist: 50_000, withdraw: 50_000, core_transfer: 50_000 };
const w3 = () => {
  if (!window.solanaWeb3) throw new Error("web3.js did not load");
  return window.solanaWeb3;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- borsh, for the argument types this program uses ----------
const enc = new TextEncoder();
function encodeArg(type, v) {
  const le = (bytes, big) => { const b = new Uint8Array(bytes); new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(big)), true); return b; };
  switch (type) {
    case "u8": return Uint8Array.of(Number(v) & 0xff);
    case "bool": return Uint8Array.of(v ? 1 : 0);
    case "u16": { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Number(v), true); return b; }
    case "u32": { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(v), true); return b; }
    case "u64": return le(8, v);
    case "i64": return le(8, v); // two's complement via asUintN
    case "pubkey": return new (w3().PublicKey)(v).toBytes();
    case "string": { const s = enc.encode(String(v)); const b = new Uint8Array(4 + s.length); new DataView(b.buffer).setUint32(0, s.length, true); b.set(s, 4); return b; }
    default: throw new Error(`no encoder for IDL type ${JSON.stringify(type)}`);
  }
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
// A transaction signature as a wallet must return it: 64 bytes in base58.
export const isSignature = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s);

const u64le = (id) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(id), true); return b; };

export async function loadIdl() {
  const r = await fetch(API + "/api/idl", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`the world did not serve its IDL (${r.status})`);
  return r.json();
}

// The identity this browser first saw for the world: program and collection.
// Returns the remembered identity when today's differs (the caller warns),
// null when it matches or is being seen for the first time.
const IDENTITY_KEY = "instar_chain_identity";
export function identityDrift(config) {
  if (!config || !config.programId || !config.collection) return null;
  const now = { programId: config.programId, collection: config.collection, cluster: config.cluster };
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null"); } catch { seen = null; }
  if (!seen || typeof seen !== "object") { rememberIdentity(now); return null; }
  return seen.programId === now.programId && seen.collection === now.collection ? null : seen;
}
export function rememberIdentity(config) {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ programId: config.programId, collection: config.collection, cluster: config.cluster })); } catch { /* private mode */ }
}

// Anchor's own error codes, so a stale page explains itself instead of
// printing a number. Constraint codes 2000-2039, account codes 3000-3017.
const CONSTRAINT = ["Mut", "HasOne", "Signer", "Raw", "Owner", "RentExempt", "Seeds", "Executable", "State", "Associated", "AssociatedInit", "Close", "Address", "Zero", "TokenMint", "TokenOwner", "MintMintAuthority", "MintFreezeAuthority", "MintDecimals", "Space", "AccountIsNone", "TokenTokenProgram", "MintTokenProgram", "AssociatedTokenTokenProgram", "MintGroupPointerExtension", "MintGroupPointerExtensionAuthority", "MintGroupPointerExtensionGroupAddress", "MintGroupMemberPointerExtension", "MintGroupMemberPointerExtensionAuthority", "MintGroupMemberPointerExtensionMemberAddress", "MintMetadataPointerExtension", "MintMetadataPointerExtensionAuthority", "MintMetadataPointerExtensionMetadataAddress", "MintCloseAuthorityExtension", "MintCloseAuthorityExtensionAuthority", "MintPermanentDelegateExtension", "MintPermanentDelegateExtensionDelegate", "MintTransferHookExtension", "MintTransferHookExtensionAuthority", "MintTransferHookExtensionProgramId"];
const ACCOUNT = ["DiscriminatorAlreadySet", "DiscriminatorNotFound", "DiscriminatorMismatch", "DidNotDeserialize", "DidNotSerialize", "NotEnoughKeys", "NotMutable", "OwnedByWrongProgram", "InvalidProgramId", "InvalidProgramExecutable", "NotSigner", "NotSystemOwned", "NotInitialized", "NotProgramData", "NotAssociatedTokenAccount", "SysvarMismatch", "ReallocExceedsLimit", "DuplicateReallocs"];
const REQUIRE = ["Require", "RequireEq", "RequireKeysEq", "RequireNeq", "RequireKeysNeq", "RequireGt", "RequireGte"];
function anchorError(code) {
  if (code >= 100 && code <= 103) return "the program did not understand the instruction; this page may be out of date, reload";
  if (code >= 1000 && code <= 1002) return "the program's IDL instruction was refused";
  if (code >= 2000 && code < 2000 + CONSTRAINT.length) {
    const name = CONSTRAINT[code - 2000];
    if (code === 2002) return "the wallet did not sign for the account the program expected; try again";
    if (code === 2020) return "an account this action needs is missing; reload and try again";
    return `an account did not match the record (Anchor Constraint${name}); reload and try again`;
  }
  if (code >= 2500 && code < 2500 + REQUIRE.length) return `a program check failed (Anchor ${REQUIRE[code - 2500]}Violated); reload and try again`;
  if (code >= 3000 && code < 3000 + ACCOUNT.length) {
    const name = ACCOUNT[code - 3000];
    if (code === 3012) return "that account does not exist yet (nothing to withdraw?)";
    if (code === 3010) return "an account that must sign did not; try again";
    if (code === 3007 || code === 3008) return `the account belongs to another program (Anchor Account${name}); reload and try again`;
    return `an account was not what the program expected (Anchor Account${name}); reload and try again`;
  }
  if (code === 4100) return "the program's declared id does not match the one deployed; the site and the chain disagree";
  if (code >= 4101 && code <= 4102) return "the program refused the input (Anchor " + (code === 4101 ? "TryingToInitPayerAsProgramAccount" : "InvalidNumericConversion") + ")";
  if (code === 5000) return "the program used a deprecated API";
  return null;
}

// One program instance per page: the IDL, the world's addresses, the RPC.
export class Program {
  constructor(idl, config) {
    const { PublicKey, Connection } = w3();
    if (!config.programId || !config.collection || !config.rpc) throw new Error("the world's config names no program, collection or rpc");
    if (config.programId !== PROGRAM_ID) throw new Error(`this page signs only for program ${PROGRAM_ID}; the world names ${config.programId}, so wallet mode is refused`);
    if (idl.address !== PROGRAM_ID) throw new Error(`the world's IDL is for program ${idl.address}, not ${PROGRAM_ID}; wallet mode is refused`);
    this.idl = idl;
    this.programId = new PublicKey(PROGRAM_ID);
    this.worldPda = PublicKey.findProgramAddressSync([enc.encode("world")], this.programId)[0];
    if (config.worldPda && config.worldPda !== this.worldPda.toBase58()) throw new Error(`the world names PDA ${config.worldPda} but the program's world is ${this.worldPda.toBase58()}; wallet mode is refused`);
    this.collection = new PublicKey(config.collection);
    this.cluster = config.cluster;
    this.priorityFee = config.cluster === "localnet" ? 0 : 5000; // microlamports per CU
    this.endpoints = [config.rpc, ...(PUBLIC_RPC[config.cluster] || []).filter(u => u !== config.rpc)];
    this.connection = new Connection(this.endpoints[0], "confirmed");
    this.errors = new Map((idl.errors || []).map(e => [e.code, e]));
  }
  pk(v) { return v instanceof w3().PublicKey ? v : new (w3().PublicKey)(v); }
  creaturePda(id) { return w3().PublicKey.findProgramAddressSync([enc.encode("creature"), u64le(id)], this.programId)[0]; }
  creditPda(owner) { return w3().PublicKey.findProgramAddressSync([enc.encode("credit"), this.pk(owner).toBytes()], this.programId)[0]; }

  // An instruction straight from the IDL entry: account order and flags from
  // `accounts[]`, fixed addresses honoured, an absent optional account passed
  // as the program id (Anchor's convention), data = discriminator + borsh args.
  instruction(name, args, accounts) {
    const ix = this.idl.instructions.find(i => i.name === name);
    if (!ix) throw new Error(`the IDL has no instruction ${name}`);
    const keys = ix.accounts.map(a => {
      let v = a.address ? a.address : accounts[a.name];
      if (v === undefined) throw new Error(`${name}: account ${a.name} not given`);
      if (v === null) { if (!a.optional) throw new Error(`${name}: account ${a.name} is required`); v = this.programId; }
      return { pubkey: this.pk(v), isSigner: !!a.signer, isWritable: !!a.writable };
    });
    const data = concat([Uint8Array.from(ix.discriminator), ...ix.args.map(arg => {
      if (!(arg.name in args)) throw new Error(`${name}: argument ${arg.name} not given`);
      return encodeArg(arg.type, args[arg.name]);
    })]);
    const out = new (w3().TransactionInstruction)({ programId: this.programId, keys, data });
    out.units = UNITS[name] || UNITS.buy;
    return out;
  }

  // ---- the keeper's instructions; `fly` is a /api/journal flies[] record ----
  buy(buyer, fly, price) {
    const hasParent = fly.parentId !== undefined && fly.parentId !== null && fly.parentId !== -1 && fly.parentId !== "none";
    return this.instruction("buy", { id: fly.id, price }, {
      world: this.worldPda, buyer, creature: this.creaturePda(fly.id),
      parent: hasParent ? this.creaturePda(fly.parentId) : null,
      asset: fly.asset, collection: this.collection,
    });
  }
  buyListed(buyer, fly, price) {
    if (!fly.listedBy || fly.listedBy === "11111111111111111111111111111111") throw new Error(`#${fly.id} is not listed`);
    return this.instruction("buy_listed", { id: fly.id, price }, {
      world: this.worldPda, buyer, creature: this.creaturePda(fly.id), asset: fly.asset, collection: this.collection,
      seller_credit: this.creditPda(fly.listedBy),
    });
  }
  list(owner, fly, price) {
    return this.instruction("list", { id: fly.id, price }, { signer: owner, creature: this.creaturePda(fly.id), asset: fly.asset });
  }
  unlist(owner, fly) {
    return this.instruction("unlist", { id: fly.id }, { signer: owner, creature: this.creaturePda(fly.id), asset: fly.asset });
  }
  requestCull(owner, fly) {
    return this.instruction("request_cull", { id: fly.id }, {
      world: this.worldPda, owner, creature: this.creaturePda(fly.id), asset: fly.asset, collection: this.collection,
    });
  }
  withdraw(owner) {
    return this.instruction("withdraw", {}, { world: this.worldPda, owner, credit: this.creditPda(owner) });
  }
  // Core TransferV1 (discriminator 14, no compression proof) signed by the
  // owner: asset, collection, payer, authority, new owner, system program,
  // log wrapper. Core's absent optional accounts are its own program id, so
  // the authority slot is the program id (the payer is the owner and signs)
  // and so is the log wrapper.
  transferAsset(owner, fly, to) {
    const { TransactionInstruction, SystemProgram, PublicKey } = w3();
    const core = new PublicKey(MPL_CORE);
    const out = new TransactionInstruction({
      programId: core,
      keys: [
        { pubkey: this.pk(fly.asset), isSigner: false, isWritable: true },
        { pubkey: this.collection, isSigner: false, isWritable: false },
        { pubkey: this.pk(owner), isSigner: true, isWritable: true },
        { pubkey: core, isSigner: false, isWritable: false },
        { pubkey: this.pk(to), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: core, isSigner: false, isWritable: false },
      ],
      data: Uint8Array.of(14, 0),
    });
    out.units = UNITS.core_transfer;
    return out;
  }

  // ---- the RPC, with fallbacks ----
  // One call on the current endpoint; when the endpoint itself fails
  // (unreachable, rate limited, down) the next public one takes over for
  // the rest of the page's life. A program or RPC *answer* is never retried.
  async rpc(method, ...args) {
    for (let i = 0; ; i++) {
      try { return await this.connection[method](...args); }
      catch (e) {
        const text = String(e && e.message || e);
        if (i + 1 >= this.endpoints.length || !/failed to fetch|fetch failed|networkerror|load failed|network request failed|access forbidden|\b(403|429|502|503|504)\b/i.test(text)) throw e;
        this.endpoints.push(this.endpoints.shift());
        this.connection = new (w3().Connection)(this.endpoints[0], "confirmed");
      }
    }
  }
  sendRaw(bytes) { return this.rpc("sendRawTransaction", bytes, { preflightCommitment: "confirmed" }); }

  // ---- reads ----
  async balance(owner) { return BigInt(await this.rpc("getBalance", this.pk(owner), "confirmed")); }
  // Credit account: 8-byte discriminator, owner pubkey, amount u64, bump.
  async credit(owner) {
    const info = await this.rpc("getAccountInfo", this.creditPda(owner), "confirmed");
    if (!info || info.data.length < 48) return 0n;
    return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(40, true);
  }

  // ---- send ----
  // One legacy transaction: compute budget (limit from the instruction table,
  // priority fee 5000 microlamports off localnet), then the instructions.
  // `who` is the signer the instructions were built for and stays the fee
  // payer; if the wallet switches accounts meanwhile the send is refused
  // rather than asking for a signature the wallet no longer holds. The
  // wallet signs (and, when it must, sends), then signature status is
  // polled, so no websocket is needed. An expiry is re-checked against
  // `landed()` (did the record change anyway?) and, if not, signed once
  // more with a fresh blockhash. Program errors come back by their IDL name.
  async send(wallet, who, ixs, { landed } = {}) {
    const { Transaction, ComputeBudgetProgram } = w3();
    const payer = this.pk(who);
    const units = ixs.reduce((n, ix) => n + (ix.units || UNITS.buy), 0);
    const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFee })];
    for (let attempt = 0; ; attempt++) {
      if (wallet.address !== who) throw new Error("the wallet switched accounts; try again");
      const { blockhash, lastValidBlockHeight } = await this.rpc("getLatestBlockhash", "confirmed");
      const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
      tx.add(...budget, ...ixs);
      let sig;
      try { sig = await wallet.signAndSend(tx, this); }
      catch (e) { throw this.explain(e); }
      if (!isSignature(sig)) throw new Error("the wallet returned no transaction signature");
      try { await this.confirm(sig, lastValidBlockHeight); return sig; }
      catch (e) {
        if (!e.expired) throw e;
        if (landed && await landed()) return sig;
        if (attempt >= 1) throw e;
      }
    }
  }
  async confirm(sig, lastValidBlockHeight) {
    const status = async (history) => (await this.rpc("getSignatureStatuses", [sig], history ? { searchTransactionHistory: true } : undefined)).value[0];
    const settled = (st) => {
      if (!st) return false;
      if (st.err) throw this.explain(new Error("transaction failed: " + JSON.stringify(st.err)));
      return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized";
    };
    for (; ;) {
      if (settled(await status(false))) return;
      if (await this.rpc("getBlockHeight", "confirmed") > lastValidBlockHeight) {
        // the status can lag the block height for a transaction included
        // at the end of its window: one last look before calling it expired
        if (settled(await status(true))) return;
        const e = new Error(`the transaction expired before it was confirmed (${sig})`);
        e.expired = true;
        throw e;
      }
      await sleep(600);
    }
  }
  explain(e) {
    const text = String(e && e.message || e);
    const logs = e && typeof e.transactionLogs === "object" ? e.transactionLogs : (e && e.logs);
    const all = text + " " + (Array.isArray(logs) ? logs.join(" ") : "");
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(all) || /"Custom":\s*(\d+)/.exec(all);
    if (m) {
      const code = m[0].includes("0x") ? parseInt(m[1], 16) : parseInt(m[1], 10);
      const known = this.errors.get(code);
      if (known) return new Error(known.msg || known.name);
      return new Error(anchorError(code) || `program error ${code}`);
    }
    if (/insufficient (lamports|funds)/i.test(all)) return new Error("not enough SOL in the wallet for this");
    if (/user rejected|rejected the request|declined/i.test(all)) return new Error("the wallet declined");
    return e instanceof Error ? e : new Error(text);
  }
}
