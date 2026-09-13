// $INSTAR's creator fees, claimed into the fee keypair.
//
// The coin is a pump.fun coin launched with `creator = <fee keypair>`. Its
// creator fees accrue in two places: while it trades on the bonding curve,
// as lamports in the Pump PDA ["creator-vault", creator]; once it graduates
// to PumpSwap, as wrapped SOL in the ATA owned by the Pump AMM PDA
// ["creator_vault", creator]. Both claims are permissionless (the creator is
// not a signer); the fee keypair signs here only as payer and, after the
// AMM claim, as owner of its own wSOL account to unwrap it. Nothing in this
// file is derived from a third-party SDK: the discriminators, account orders
// and seeds are copied from pump's published IDLs (pump.json, pump_amm.json,
// pump_fees.json in github.com/pump-fun/pump-public-docs), and the builders
// assert the account count against those tables.
//
// The world calls `claim()` ahead of its ten-minute sweep, so whatever the
// coin earned reaches the dish in the same pass.

import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { Chain, formatSol } from "./solana.mts";

export const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Below this a claim costs more in fees and rent churn than it moves.
export const MIN_CLAIM = 1_000_000n;
/// Compute-unit limits, from `scripts/fees.mts claim --dry-run` simulated on
/// mainnet against graduated coins (2026-09): collect_creator_fee_v2 24.3k,
/// the AMM leg (ATA create + collect + close) 30.9k, a lone close under 1k.
/// Each limit is at least 3x its measurement; the priority fee is priced on
/// the limit.
export const CLAIM_CU = { CURVE: 75_000, AMM: 100_000, UNWRAP: 10_000 } as const;
/// The fee keypair pays every claim and nothing but a claim ever pays it, so
/// it must be seeded by hand. Preflight fails below this (0.02 SOL: rent for
/// itself and a transient wSOL account, plus a season of fees).
export const FEE_KEYPAIR_MIN = 20_000_000n;
/// The sweep leaves INSTAR_GAS_RESERVE in the fee keypair; below this the
/// AMM leg cannot front the wSOL account's rent (a token account's minimum,
/// 1,488,440 lamports read from mainnet in 2026-09; 2,039,280 under the
/// older rent parameters) and the next claim fails.
export const GAS_RESERVE_MIN = 3_000_000n;
/// Every read here goes through web3.js `Connection`, which has no fetch
/// timeout; a half-open socket would otherwise pin the world's sweep guard.
export const READ_TIMEOUT_MS = 30_000;

export function withTimeout<T>(p: Promise<T>, what: string, ms = READ_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const gate = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the RPC in ${ms / 1000}s`)), ms); });
  return Promise.race([p, gate]).finally(() => clearTimeout(timer));
}

// ---- instruction tables, from the IDLs --------------------------------------

export type AccountSpec = { name: string; writable: boolean; signer: boolean };
export type IxSpec = { name: string; program: PublicKey; discriminator: number[]; accounts: AccountSpec[] };
const acct = (name: string, writable = false, signer = false): AccountSpec => ({ name, writable, signer });

/// Pump `collect_creator_fee_v2`: moves the creator vault's lamports above
/// rent to `creator`. For a wSOL coin the two token accounts are passed by
/// address and need not exist.
export const COLLECT_CREATOR_FEE_V2: IxSpec = {
  name: "collect_creator_fee_v2", program: PUMP, discriminator: [207, 17, 138, 242, 4, 34, 19, 56],
  accounts: [
    acct("creator", true), acct("creator_token_account", true), acct("creator_vault", true), acct("creator_vault_token_account", true),
    acct("quote_mint"), acct("quote_token_program"), acct("associated_token_program"), acct("system_program"),
    acct("event_authority"), acct("program"),
  ],
};

/// Pump AMM `collect_coin_creator_fee`: moves the AMM creator vault's wSOL
/// to the creator's wSOL account, which must exist.
export const COLLECT_COIN_CREATOR_FEE: IxSpec = {
  name: "collect_coin_creator_fee", program: PUMP_AMM, discriminator: [160, 57, 89, 42, 181, 139, 43, 66],
  accounts: [
    acct("quote_mint"), acct("quote_token_program"), acct("coin_creator"), acct("coin_creator_vault_authority"),
    acct("coin_creator_vault_ata", true), acct("coin_creator_token_account", true), acct("event_authority"), acct("program"),
  ],
};

/// Associated Token program `CreateIdempotent` (instruction 1).
export const CREATE_ATA_IDEMPOTENT: IxSpec = {
  name: "create_associated_token_account_idempotent", program: ATA_PROGRAM, discriminator: [1],
  accounts: [acct("payer", true, true), acct("associated_token_account", true), acct("owner"), acct("mint"), acct("system_program"), acct("token_program")],
};

/// SPL Token `CloseAccount` (instruction 9): the wSOL account's lamports,
/// rent included, go to `destination`; unwrapping is exactly this.
export const CLOSE_ACCOUNT: IxSpec = {
  name: "close_account", program: TOKEN_PROGRAM, discriminator: [9],
  accounts: [acct("account", true), acct("destination", true), acct("owner", false, true)],
};

export function instruction(spec: IxSpec, keys: PublicKey[]): TransactionInstruction {
  if (keys.length !== spec.accounts.length) throw new Error(`${spec.name}: ${keys.length} accounts given, the IDL lists ${spec.accounts.length}`);
  return new TransactionInstruction({
    programId: spec.program,
    keys: keys.map((pubkey, i) => ({ pubkey, isWritable: spec.accounts[i].writable, isSigner: spec.accounts[i].signer })),
    data: Buffer.from(spec.discriminator),
  });
}

const SPECS = [COLLECT_CREATOR_FEE_V2, COLLECT_COIN_CREATOR_FEE, CREATE_ATA_IDEMPOTENT, CLOSE_ACCOUNT];
/// The table an instruction was built from, for printing a plan.
export function specOf(ix: TransactionInstruction): IxSpec | null {
  return SPECS.find(s => s.program.equals(ix.programId) && Buffer.from(s.discriminator).equals(ix.data.subarray(0, s.discriminator.length))) ?? null;
}

// ---- addresses ----------------------------------------------------------------

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
export const ata = (owner: PublicKey, mint: PublicKey) => pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
const eventAuthority = (program: PublicKey) => pda([Buffer.from("__event_authority")], program);

export function feeAddresses(mint: PublicKey, creator: PublicKey) {
  const curveVault = pda([Buffer.from("creator-vault"), creator.toBuffer()], PUMP);
  const poolAuthority = pda([Buffer.from("pool-authority"), mint.toBuffer()], PUMP);
  const ammVaultAuthority = pda([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM);
  return {
    bondingCurve: pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP),
    curveVault, curveVaultAta: ata(curveVault, WSOL),
    creatorWsol: ata(creator, WSOL),
    /// the canonical PumpSwap pool, the one `migrate` creates: index 0, created by the pool-authority PDA
    pool: pda([Buffer.from("pool"), Buffer.from([0, 0]), poolAuthority.toBuffer(), mint.toBuffer(), WSOL.toBuffer()], PUMP_AMM),
    ammVaultAuthority, ammVaultAta: ata(ammVaultAuthority, WSOL),
    sharingConfig: pda([Buffer.from("sharing-config"), mint.toBuffer()], PUMP_FEES),
  };
}

// ---- account decoding ---------------------------------------------------------

const BONDING_CURVE_DISC = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

export type CurveView = { address: PublicKey; complete: boolean; creator: PublicKey; quoteMint: PublicKey; holderReward: boolean };
export type PoolView = { address: PublicKey; creator: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; coinCreator: PublicKey };

/// BondingCurve, fields in IDL order behind the discriminator: five u64
/// reserves/supply, `complete`, `creator`, mayhem and cashback flags,
/// `quote_mint`, `creator_fee_bps`, `can_edit_creator_fee`, `is_holder_reward`.
/// Older curves were shorter and are extended lazily; a missing tail reads as
/// its default (no creator, SOL quote).
export function decodeCurve(address: PublicKey, data: Buffer): CurveView {
  if (data.length < 49 || !data.subarray(0, 8).equals(BONDING_CURVE_DISC)) throw new Error(`${address.toBase58()} is not a BondingCurve`);
  const quote = data.length >= 115 ? new PublicKey(data.subarray(83, 115)) : PublicKey.default;
  return {
    address, complete: data[48] === 1,
    creator: data.length >= 81 ? new PublicKey(data.subarray(49, 81)) : PublicKey.default,
    quoteMint: quote.equals(PublicKey.default) ? WSOL : quote,
    holderReward: data.length >= 125 && data[124] === 1,
  };
}

/// Pool: bump, index u16, creator, base_mint, quote_mint, lp_mint, the two
/// vault token accounts, lp_supply u64, coin_creator.
export function decodePool(address: PublicKey, data: Buffer): PoolView {
  if (data.length < 243 || !data.subarray(0, 8).equals(POOL_DISC)) throw new Error(`${address.toBase58()} is not a PumpSwap Pool`);
  return {
    address, creator: new PublicKey(data.subarray(11, 43)), baseMint: new PublicKey(data.subarray(43, 75)),
    quoteMint: new PublicKey(data.subarray(75, 107)), coinCreator: new PublicKey(data.subarray(211, 243)),
  };
}

/// SPL token account: mint, owner, then the u64 amount at offset 64.
const tokenAmount = (data: Buffer | null | undefined) => data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n;

// ---- the claimer ----------------------------------------------------------------

export type FeeStatus = {
  mint: PublicKey;
  /// whose vaults were read: the fee keypair, unless overridden for a read-only look at another coin
  creator: PublicKey;
  /// rent-exempt minimum of an empty account (the vault floor) and of a token account
  vaultRent: bigint;
  ataRent: bigint;
  curve: CurveView | null;
  curveVault: { address: PublicKey; lamports: bigint; claimable: bigint };
  pool: PoolView | null;
  ammVault: { authority: PublicKey; ata: PublicKey; exists: boolean; amount: bigint };
  creatorWsol: { ata: PublicKey; exists: boolean; amount: bigint };
  sharingConfig: { address: PublicKey; exists: boolean };
  feeBalance: bigint;
  /// the creator's own balance: the fee keypair's again, unless overridden
  creatorBalance: bigint;
  /// why no claim of this coin can pay this creator; empty when the coin is claimable by this creator
  problems: string[];
  /// why the PumpSwap leg alone would fail or pay someone else; the curve leg is unaffected
  poolProblems: string[];
};

export type LegName = "curve" | "amm" | "unwrap";
export const LEG_SOURCE: Record<LegName, string> = {
  curve: "the bonding-curve vault", amm: "the PumpSwap vault", unwrap: "the fee keypair's wSOL account",
};

export type ClaimLeg = {
  leg: LegName;
  /// what the leg moves, as read; the result carries what actually arrived
  lamports: bigint;
  ixs: TransactionInstruction[];
  units: number;
  /// what the fee keypair must hold to pay for it: its own rent floor, the fee, and any rent it fronts
  needs: bigint;
  /// re-reads the target: true once it is drained, so a resend cannot double-claim
  landed: () => Promise<boolean>;
};
export type ClaimPlan = {
  legs: ClaimLeg[];
  skipped: string[];
  /// the most a leg left out for lack of SOL would need the fee keypair to hold; null when money was not the reason
  needs: bigint | null;
};
/// `signature` is null when the target was found drained before this
/// process's transaction landed: someone else cranked the permissionless
/// claim. `lamports` is the fee keypair's balance change over the leg, fees
/// and returned rent included.
export type ClaimResult = { leg: LegName; signature: string | null; lamports: bigint };

export type FeeClaimerOpts = { chain: Chain; mint: PublicKey; fee: Keypair; creator?: PublicKey; log?: (line: string) => void };

export class FeeClaimer {
  readonly chain: Chain;
  readonly mint: PublicKey;
  readonly fee: Keypair;
  readonly creator: PublicKey;
  readonly addresses: ReturnType<typeof feeAddresses>;
  private readonly log: (line: string) => void;
  private rents: { vault: bigint; ata: bigint } | null = null;
  /// the last claim this process sent
  last: { at: number; results: ClaimResult[] } | null = null;

  constructor(opts: FeeClaimerOpts) {
    this.chain = opts.chain;
    this.mint = opts.mint;
    this.fee = opts.fee;
    this.creator = opts.creator ?? opts.fee.publicKey;
    this.addresses = feeAddresses(this.mint, this.creator);
    this.log = opts.log ?? (() => undefined);
  }

  async status(): Promise<FeeStatus> {
    const a = this.addresses;
    const [infos, rents] = await withTimeout(Promise.all([
      this.chain.connection.getMultipleAccountsInfo([a.bondingCurve, a.curveVault, a.pool, a.ammVaultAta, a.creatorWsol, a.sharingConfig, this.fee.publicKey, this.creator]),
      this.rents ?? Promise.all([this.chain.rentExempt(0), this.chain.rentExempt(165)]).then(([vault, ata]) => ({ vault, ata })),
    ]), "fee status");
    this.rents = rents;
    const rent = rents.vault;
    // anyone can send lamports to any address, so an account exists in the
    // sense that matters only when its program owns it
    const ownedBy = (info: AccountInfo<Buffer> | null, program: PublicKey) => info && info.owner.equals(program) ? info : null;
    const [curveInfo, vaultInfo, poolInfo, ammAtaInfo, wsolInfo, sharingInfo, feeInfo, creatorInfo] = infos;
    const curve = curveInfo?.owner.equals(PUMP) ? decodeCurve(a.bondingCurve, curveInfo.data) : null;
    const pool = poolInfo?.owner.equals(PUMP_AMM) ? decodePool(a.pool, poolInfo.data) : null;
    const ammAta = ownedBy(ammAtaInfo, TOKEN_PROGRAM), wsol = ownedBy(wsolInfo, TOKEN_PROGRAM), sharing = ownedBy(sharingInfo, PUMP_FEES);
    const vaultLamports = BigInt(vaultInfo?.lamports ?? 0);
    const claimable = vaultLamports > rent ? vaultLamports - rent : 0n;
    const problems: string[] = [];
    const poolProblems: string[] = [];
    if (!curve) problems.push(`no bonding curve at ${a.bondingCurve.toBase58()}: ${this.mint.toBase58()} was not launched on pump.fun`);
    else {
      if (!curve.creator.equals(this.creator)) problems.push(`the bonding curve's creator is ${curve.creator.toBase58()}, not ${this.creator.toBase58()}: its fees go there`);
      if (curve.holderReward) problems.push("holder-reward coin: creator fees are paid to holders, never to a creator");
      if (!curve.quoteMint.equals(WSOL)) problems.push(`quoted in ${curve.quoteMint.toBase58()}, not SOL: unsupported`);
    }
    if (sharing) problems.push(`a fee sharing config exists at ${a.sharingConfig.toBase58()}: fees are distributed by pump-fees, the plain claim is rejected (unsupported)`);
    if (creatorInfo && !creatorInfo.owner.equals(SystemProgram.programId)) problems.push(`${this.creator.toBase58()} is owned by ${creatorInfo.owner.toBase58()}, not a wallet: the claim rejects it`);
    // `migrate` passes the curve's creator into `create_pool`, so the two
    // agree from the moment the pool exists; only pump admin (admin_cto_pool)
    // can make them differ, and then for good. The curve vault is a separate
    // account and stays claimable.
    if (pool && !pool.coinCreator.equals(this.creator)) poolProblems.push(`the PumpSwap pool's coin_creator is ${pool.coinCreator.toBase58()}, not ${this.creator.toBase58()} (only pump admin can change it: admin_cto_pool); AMM fees go there`);
    return {
      mint: this.mint, creator: this.creator, vaultRent: rent, ataRent: rents.ata, curve,
      curveVault: { address: a.curveVault, lamports: vaultLamports, claimable },
      pool,
      ammVault: { authority: a.ammVaultAuthority, ata: a.ammVaultAta, exists: !!ammAta, amount: tokenAmount(ammAta?.data) },
      creatorWsol: { ata: a.creatorWsol, exists: !!wsol, amount: tokenAmount(wsol?.data) },
      sharingConfig: { address: a.sharingConfig, exists: !!sharing },
      feeBalance: BigInt(feeInfo?.lamports ?? 0), creatorBalance: BigInt(creatorInfo?.lamports ?? 0),
      problems, poolProblems,
    };
  }

  /// The curve leg: one instruction, vault lamports to the creator.
  curveInstructions(): TransactionInstruction[] {
    const a = this.addresses;
    return [instruction(COLLECT_CREATOR_FEE_V2, [
      this.creator, a.creatorWsol, a.curveVault, a.curveVaultAta,
      WSOL, TOKEN_PROGRAM, ATA_PROGRAM, SystemProgram.programId, eventAuthority(PUMP), PUMP,
    ])];
  }

  /// The AMM leg: make sure the creator's wSOL account exists, collect into
  /// it, close it back into the creator. The close needs the creator's
  /// signature, which is why the creator must be the fee keypair to claim.
  ammInstructions(): TransactionInstruction[] {
    const a = this.addresses;
    return [
      instruction(CREATE_ATA_IDEMPOTENT, [this.fee.publicKey, a.creatorWsol, this.creator, WSOL, SystemProgram.programId, TOKEN_PROGRAM]),
      instruction(COLLECT_COIN_CREATOR_FEE, [WSOL, TOKEN_PROGRAM, this.creator, a.ammVaultAuthority, a.ammVaultAta, a.creatorWsol, eventAuthority(PUMP_AMM), PUMP_AMM]),
      instruction(CLOSE_ACCOUNT, [a.creatorWsol, this.creator, this.creator]),
    ];
  }

  /// The unwrap leg: the AMM claim is permissionless and always pays the
  /// creator's wSOL account, so when someone else cranks it the wSOL sits
  /// there, unclosed. Closing it alone brings it (and the account's rent)
  /// into the fee keypair.
  unwrapInstructions(): TransactionInstruction[] {
    return [instruction(CLOSE_ACCOUNT, [this.addresses.creatorWsol, this.creator, this.creator])];
  }

  /// What `claim` would send for this status: each leg with something worth
  /// taking that the fee keypair can pay for, and why the others are skipped.
  plan(s: FeeStatus): ClaimPlan {
    const legs: ClaimLeg[] = [];
    const skipped: string[] = [];
    const unaffordable: bigint[] = [];
    const c = this.chain.connection;
    const consider = (leg: ClaimLeg): boolean => {
      if (s.feeBalance >= leg.needs) { legs.push(leg); return true; }
      skipped.push(`${LEG_SOURCE[leg.leg]}: the fee keypair holds ${formatSol(s.feeBalance)} SOL and the transaction needs about ${formatSol(leg.needs)}`);
      unaffordable.push(leg.needs);
      return false;
    };
    if (s.curveVault.claimable >= MIN_CLAIM) {
      consider({
        leg: "curve", lamports: s.curveVault.claimable, ixs: this.curveInstructions(), units: CLAIM_CU.CURVE,
        needs: s.vaultRent + this.chain.fee(CLAIM_CU.CURVE),
        landed: async () => BigInt(await c.getBalance(s.curveVault.address)) - s.vaultRent < MIN_CLAIM,
      });
    } else skipped.push(`curve vault holds ${formatSol(s.curveVault.claimable)} SOL above rent (minimum ${formatSol(MIN_CLAIM)})`);
    let amm = false;
    if (!s.pool) skipped.push("no canonical PumpSwap pool: not graduated");
    else if (s.poolProblems.length) skipped.push(...s.poolProblems.map(p => `PumpSwap: ${p}`));
    else if (!s.ammVault.exists) skipped.push("AMM creator vault account does not exist yet (PumpSwap creates it on the first fee)");
    else if (s.ammVault.amount >= MIN_CLAIM) {
      amm = consider({
        leg: "amm", lamports: s.ammVault.amount, ixs: this.ammInstructions(), units: CLAIM_CU.AMM,
        needs: s.vaultRent + s.ataRent + this.chain.fee(CLAIM_CU.AMM),
        landed: async () => tokenAmount((await c.getAccountInfo(s.ammVault.ata))?.data) < MIN_CLAIM,
      });
    } else skipped.push(`AMM vault holds ${formatSol(s.ammVault.amount)} wSOL (minimum ${formatSol(MIN_CLAIM)})`);
    // the AMM leg closes the account itself; otherwise anything in it is stranded
    if (!amm && s.creatorWsol.exists && s.creatorWsol.amount > 0n) {
      consider({
        leg: "unwrap", lamports: s.creatorWsol.amount, ixs: this.unwrapInstructions(), units: CLAIM_CU.UNWRAP,
        needs: s.vaultRent + this.chain.fee(CLAIM_CU.UNWRAP),
        landed: async () => (await c.getAccountInfo(s.creatorWsol.ata)) === null,
      });
    }
    return { legs, skipped, needs: unaffordable.length ? unaffordable.reduce((m, n) => n > m ? n : m) : null };
  }

  /// Claim both vaults into the fee keypair, one transaction per leg, each
  /// re-checked against the chain before it goes out. Returns what landed;
  /// a coin whose fees would go elsewhere is an error, not a silent skip.
  async claim(): Promise<ClaimResult[]> {
    if (!this.creator.equals(this.fee.publicKey)) throw new Error(`claiming needs the fee keypair as creator; this claimer reads ${this.creator.toBase58()}`);
    const s = await this.status();
    if (s.problems.length) throw new Error(s.problems.join("; "));
    const plan = this.plan(s);
    if (plan.needs !== null) this.log(`fee keypair needs SOL for claims (has ${formatSol(s.feeBalance)}, needs about ${formatSol(plan.needs)})`);
    const results: ClaimResult[] = [];
    let before = s.feeBalance;
    for (const leg of plan.legs) {
      // `send` also counts the leg as done when the target reads as drained
      // while its own signature has not confirmed. These claims are
      // permissionless, so that is somebody else's transaction, not ours.
      let byState = false;
      const landed = async () => {
        const drained = await withTimeout(leg.landed(), `${leg.leg} re-read`);
        if (drained) byState = true;
        return drained;
      };
      const sig = await this.chain.send(leg.ixs, [this.fee], landed, leg.units);
      const after = await withTimeout(this.chain.balance(this.fee.publicKey), "fee keypair balance");
      const lamports = after - before;
      before = after;
      const ours = !byState || await withTimeout(this.chain.signatureLanded(sig), "signature status");
      results.push({ leg: leg.leg, signature: ours ? sig : null, lamports });
      if (ours) this.log(`claimed ${formatSol(lamports)} SOL of creator fees from ${LEG_SOURCE[leg.leg]}, net of the fee (${sig})`);
      else this.log(`vault drained by another crank: ${LEG_SOURCE[leg.leg]} was empty before ${sig} landed; nothing sent by this process`);
    }
    this.last = { at: Date.now(), results };
    return results;
  }
}
