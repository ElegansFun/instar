// End-to-end suite against `anchor test`'s local validator. The program is
// built with the `short-timers` feature so the recovery drills wait their
// timers out in real time (ABANDONED_AFTER = ESCHEAT_AFTER = 4 s,
// CULL_TIMEOUT = 3 s). Everything runs against one World, so the order of the
// tests is the order of the world's life: market, deaths, administration, and
// finally the operator vanishing.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import type { Instar } from "../target/types/instar.ts";

const ABANDONED_AFTER_S = 4;
const ESCHEAT_AFTER_S = 4;
const CULL_TIMEOUT_S = 3;

const NO_PARENT = new BN("18446744073709551615");
const TAKE_ALL = new BN("18446744073709551615");
const STATUS_OFFERED = 1;
const STATUS_OWNED = 2;
const STATUS_WILD = 3;
const STATUS_DEAD = 4;
const CAUSE_STARVED = 1;
const CAUSE_CULLED = 6;

const SOL = (n: number) => new BN(Math.round(n * LAMPORTS_PER_SOL));
const bps = (amount: BN, share: number) => amount.muln(share).divn(10_000);
const sleep = (s: number) => delay(s * 1000);

describe("instar", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.instar as Program<Instar>;
  const conn = provider.connection;
  const operator = provider.wallet.publicKey;

  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const charlie = Keypair.generate(); // a keeper who loses their key
  const stranger = Keypair.generate();
  const recovery = Keypair.generate();
  const sink = Keypair.generate();

  const [worldPda] = PublicKey.findProgramAddressSync([Buffer.from("world")], program.programId);
  const creaturePda = (id: BN) =>
    PublicKey.findProgramAddressSync([Buffer.from("creature"), id.toArrayLike(Buffer, "le", 8)], program.programId)[0];
  const creditPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("credit"), owner.toBuffer()], program.programId)[0];

  const world = () => program.account.world.fetch(worldPda);
  const creature = (id: BN) => program.account.creature.fetch(creaturePda(id));
  const credit = async (owner: PublicKey) => {
    const c = await program.account.credit.fetchNullable(creditPda(owner));
    return c ? c.amount : new BN(0);
  };
  const lamports = async (k: PublicKey) => new BN(await conn.getBalance(k));
  const remaining = (keys: PublicKey[]) => keys.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }));

  async function airdrop(k: PublicKey, sol: number) {
    const sig = await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  /// The invariant, checked two ways: the balance above rent covers the
  /// ledger, and the running totals equal what the creature and credit
  /// accounts actually say.
  async function assertSolvent(label: string, checkTotals = true) {
    const w = await world();
    const info = await conn.getAccountInfo(worldPda);
    expect(info, `${label}: world exists`).to.not.be.null;
    const rent = await conn.getMinimumBalanceForRentExemption(info!.data.length);
    const free = new BN(info!.lamports - rent);
    const accounted = w.metabolism.add(w.pool).add(w.totalVaults).add(w.totalCredit);
    expect(free.gte(accounted), `${label}: free ${free} >= accounted ${accounted}`).to.be.true;
    if (!checkTotals) return;
    const vaults = (await program.account.creature.all()).reduce((s, c) => s.add(c.account.vault), new BN(0));
    const credits = (await program.account.credit.all()).reduce((s, c) => s.add(c.account.amount), new BN(0));
    expect(vaults.toString(), `${label}: total_vaults matches the creatures`).to.equal(w.totalVaults.toString());
    expect(credits.toString(), `${label}: total_credit matches the credits`).to.equal(w.totalCredit.toString());
  }

  /// Anchor errors carry a code; anything else is matched on its message.
  async function expectError(p: Promise<unknown>, code: string) {
    let failure: unknown;
    try {
      await p;
    } catch (e) {
      failure = e;
    }
    if (failure === undefined) throw new Error(`expected ${code}, but the transaction succeeded`);
    const got = failure instanceof anchor.AnchorError ? failure.error.errorCode.code : undefined;
    if (got === code) return;
    const text = failure instanceof Error ? failure.message : String(failure);
    if (text.includes(code)) return;
    throw new Error(`expected ${code}, got: ${text.slice(0, 400)}`);
  }

  async function newborn(price: BN, parentId: BN = NO_PARENT, generation = 0): Promise<BN> {
    const id = (await world()).nextId;
    await program.methods
      .registerBirth(id, parentId, generation, new BN(100), Array.from(Buffer.alloc(32, 1)))
      .accountsPartial({ world: worldPda, operator, creature: creaturePda(id) })
      .rpc();
    await program.methods.openOffer(id, price).accountsPartial({ world: worldPda, operator, creature: creaturePda(id) }).rpc();
    return id;
  }

  async function buy(id: BN, price: BN, buyer: Keypair, parent: BN | null = null) {
    await program.methods
      .buy(id, price)
      .accountsPartial({
        world: worldPda,
        buyer: buyer.publicKey,
        creature: creaturePda(id),
        parent: parent ? creaturePda(parent) : null,
      })
      .signers([buyer])
      .rpc();
  }

  async function settleDeath(id: BN, cause: number, heirs: BN[], keeper: PublicKey | null) {
    await program.methods
      .settleDeath(id, cause, new BN(300), heirs.length)
      .accountsPartial({
        world: worldPda,
        operator,
        creature: creaturePda(id),
        keeperCredit: keeper ? creditPda(keeper) : null,
      })
      .remainingAccounts(remaining(heirs.map(creaturePda)))
      .rpc();
  }

  async function withdraw(who: Keypair) {
    await program.methods
      .withdraw()
      .accountsPartial({ world: worldPda, owner: who.publicKey, credit: creditPda(who.publicKey) })
      .signers([who])
      .rpc();
  }

  // ids that later tests rely on
  let first: BN; // alice buys, sells to bob, later dies with a child heir
  let child: BN; // bob's child, alice keeps it
  let aliceKept: BN; // alice's larva that survives to the recovery drills
  let charlieKept: BN; // charlie's larva that nobody ever comes back for

  before(async () => {
    await Promise.all([alice, bob, charlie, stranger].map((k) => airdrop(k.publicKey, 20)));
  });

  const programDataPda = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  )[0];
  const initWorld = (recoveryKey: PublicKey, signer?: Keypair) =>
    program.methods
      .initWorld(recoveryKey)
      .accountsPartial({ world: worldPda, operator: signer ? signer.publicKey : operator, program: program.programId, programData: programDataPda })
      .signers(signer ? [signer] : [])
      .rpc();

  it("only the upgrade authority can create the world, and never with itself as recovery", async () => {
    await expectError(initWorld(recovery.publicKey, stranger), "NotOperator");
    await expectError(initWorld(operator), "RecoveryIsOperator");
    await expectError(initWorld(PublicKey.default), "WrongId");
  });

  it("init_world fixes the recovery address before the first lamport", async () => {
    await initWorld(recovery.publicKey);
    const w = await world();
    expect(w.operator.equals(operator)).to.be.true;
    expect(w.recovery.equals(recovery.publicKey)).to.be.true;
    expect(w.windDown).to.be.false;
    expect(w.nextId.toNumber()).to.equal(0);
    expect(w.lastOperatorAction.toNumber()).to.be.greaterThan(0);
    await assertSolvent("init");
  });

  it("you cannot buy an id that was never born", async () => {
    await expectError(buy(new BN(999_999), SOL(0), alice), "AccountNotInitialized");
    const next = (await world()).nextId;
    await expectError(buy(next, SOL(0), alice), "AccountNotInitialized");
  });

  it("register_birth requires the next id in sequence", async () => {
    const id = (await world()).nextId;
    const wrong = id.addn(1);
    await expectError(
      program.methods
        .registerBirth(wrong, NO_PARENT, 0, new BN(1), Array.from(Buffer.alloc(32)))
        .accountsPartial({ world: worldPda, operator, creature: creaturePda(wrong) })
        .rpc(),
      "WrongId"
    );
  });

  it("buy splits 60/15/15 and the parentless royalty falls to the pool", async () => {
    first = await newborn(SOL(1));
    expect((await creature(first)).status).to.equal(STATUS_OFFERED);
    const before = await lamports(worldPda);
    await buy(first, SOL(1), alice);
    const c = await creature(first);
    const w = await world();
    expect(c.keeper.equals(alice.publicKey)).to.be.true;
    expect(c.status).to.equal(STATUS_OWNED);
    expect(c.salePrice.toNumber()).to.equal(0);
    expect(c.vault.toString()).to.equal(SOL(0.6).toString());
    expect(w.metabolism.toString()).to.equal(SOL(0.15).toString());
    expect(w.pool.toString()).to.equal(SOL(0.25).toString());
    expect((await lamports(worldPda)).sub(before).toString()).to.equal(SOL(1).toString());
    await assertSolvent("buy");
  });

  it("a buyer is never charged a price they did not see", async () => {
    const id = await newborn(SOL(1));
    await expectError(buy(id, SOL(1).addn(1), alice), "WrongPrice");
    await expectError(buy(id, SOL(0.5), alice), "WrongPrice");
    await buy(id, SOL(1), alice);
    await expectError(buy(id, SOL(1), bob), "NotForSale");
    aliceKept = id;
  });

  it("resale pays the seller 90 percent and the vault travels", async () => {
    await program.methods
      .list(first, SOL(2))
      .accountsPartial({ keeper: alice.publicKey, creature: creaturePda(first) })
      .signers([alice])
      .rpc();
    expect((await creature(first)).salePrice.toString()).to.equal(SOL(2).toString());
    await expectError(
      program.methods
        .list(first, SOL(2))
        .accountsPartial({ keeper: bob.publicKey, creature: creaturePda(first) })
        .signers([bob])
        .rpc(),
      "NotKeeper"
    );
    const w0 = await world();
    await program.methods
      .buyListed(first, SOL(2))
      .accountsPartial({
        world: worldPda,
        buyer: bob.publicKey,
        creature: creaturePda(first),
        sellerCredit: creditPda(alice.publicKey),
      })
      .signers([bob])
      .rpc();
    const c = await creature(first);
    const w = await world();
    expect(c.keeper.equals(bob.publicKey)).to.be.true;
    expect(c.salePrice.toNumber()).to.equal(0);
    expect(c.vault.toString(), "vault travelled untouched").to.equal(SOL(0.6).toString());
    expect((await credit(alice.publicKey)).toString()).to.equal(SOL(1.8).toString());
    expect(w.metabolism.sub(w0.metabolism).toString()).to.equal(SOL(0.1).toString());
    expect(w.pool.sub(w0.pool).toString()).to.equal(SOL(0.1).toString());
    await assertSolvent("resale");
  });

  it("unlisted larvae are not for sale", async () => {
    await program.methods
      .list(first, SOL(3))
      .accountsPartial({ keeper: bob.publicKey, creature: creaturePda(first) })
      .signers([bob])
      .rpc();
    await program.methods
      .unlist(first)
      .accountsPartial({ keeper: bob.publicKey, creature: creaturePda(first) })
      .signers([bob])
      .rpc();
    await expectError(
      program.methods
        .buyListed(first, SOL(3))
        .accountsPartial({
          world: worldPda,
          buyer: alice.publicKey,
          creature: creaturePda(first),
          sellerCredit: creditPda(bob.publicKey),
        })
        .signers([alice])
        .rpc(),
      "NotForSale"
    );
  });

  it("withdraw pulls the credit with no help from anyone", async () => {
    const before = await lamports(alice.publicKey);
    await withdraw(alice);
    expect((await lamports(alice.publicKey)).sub(before).toString()).to.equal(SOL(1.8).toString());
    expect((await credit(alice.publicKey)).toNumber()).to.equal(0);
    await expectError(withdraw(alice), "NothingToWithdraw");
    await assertSolvent("withdraw");
  });

  it("the ancestry royalty pays a parent that is still kept", async () => {
    child = await newborn(SOL(0.1), first, 1);
    const p0 = await creature(first);
    const w0 = await world();
    await expectError(buy(child, SOL(0.1), alice, aliceKept), "ConstraintSeeds");
    await expectError(buy(child, SOL(0.1), alice, null), "WrongId");
    await buy(child, SOL(0.1), alice, first);
    const p = await creature(first);
    const w = await world();
    expect(p.vault.sub(p0.vault).toString()).to.equal(SOL(0.01).toString());
    expect(w.pool.sub(w0.pool).toString()).to.equal(SOL(0.015).toString());
    expect(w.metabolism.sub(w0.metabolism).toString()).to.equal(SOL(0.015).toString());
    expect((await creature(child)).vault.toString()).to.equal(SOL(0.06).toString());
    await assertSolvent("royalty");
  });

  it("reward_many pays everyone in one transaction and skips the dead", async () => {
    const ids = [await newborn(SOL(0.5)), await newborn(SOL(0.5)), await newborn(SOL(0.5))];
    for (const id of ids) await buy(id, SOL(0.5), alice);
    const amounts = [new BN(1000), new BN(2000), new BN(7)];
    const before = await Promise.all(ids.map((id) => creature(id)));
    const w0 = await world();
    await program.methods
      .rewardMany(amounts)
      .accountsPartial({ world: worldPda, operator })
      .remainingAccounts(remaining(ids.map(creaturePda)))
      .rpc();
    const after = await Promise.all(ids.map((id) => creature(id)));
    for (let i = 0; i < 3; i++) {
      expect(after[i].vault.sub(before[i].vault).toString()).to.equal(amounts[i].toString());
    }
    expect(w0.pool.sub((await world()).pool).toNumber()).to.equal(3007);

    await settleDeath(ids[1], CAUSE_STARVED, [], alice.publicKey);
    const w1 = await world();
    await program.methods
      .rewardMany(amounts)
      .accountsPartial({ world: worldPda, operator })
      .remainingAccounts(remaining(ids.map(creaturePda)))
      .rpc();
    expect(w1.pool.sub((await world()).pool).toNumber(), "the dead one is skipped, not paid").to.equal(1007);
    expect((await creature(ids[1])).vault.toNumber()).to.equal(0);

    await expectError(
      program.methods
        .rewardMany([w1.pool.addn(1)])
        .accountsPartial({ world: worldPda, operator })
        .remainingAccounts(remaining([creaturePda(ids[0])]))
        .rpc(),
      "Insolvent"
    );
    await expectError(
      program.methods
        .rewardMany([new BN(1), new BN(1)])
        .accountsPartial({ world: worldPda, operator })
        .remainingAccounts(remaining([creaturePda(ids[0])]))
        .rpc(),
      "WrongId"
    );
    // a dead larva cannot inherit
    await expectError(settleDeath(ids[2], CAUSE_STARVED, [ids[1]], alice.publicKey), "WrongStatus");
    await assertSolvent("reward_many");
  });

  it("death pays the heirs 40 percent in equal shares, dust to the pool", async () => {
    const heirs = [await newborn(SOL(0.2)), await newborn(SOL(0.2)), await newborn(SOL(0.2))];
    for (const h of heirs) await buy(h, SOL(0.2), bob);
    const estate = (await creature(first)).vault;
    expect(estate.toString()).to.equal(SOL(0.61).toString());
    const h0 = await Promise.all(heirs.map(creature));
    const w0 = await world();
    const bobCredit0 = await credit(bob.publicKey);

    await settleDeath(first, CAUSE_STARVED, heirs, bob.publicKey);

    const toHeirs = bps(estate, 4000);
    const each = toHeirs.divn(3);
    const dust = toHeirs.sub(each.muln(3));
    expect(dust.toNumber(), "this estate does not divide evenly").to.be.greaterThan(0);
    const h1 = await Promise.all(heirs.map(creature));
    for (let i = 0; i < 3; i++) expect(h1[i].vault.sub(h0[i].vault).toString()).to.equal(each.toString());
    const w = await world();
    expect(w.metabolism.sub(w0.metabolism).toString()).to.equal(bps(estate, 3500).toString());
    expect(w.pool.sub(w0.pool).toString()).to.equal(bps(estate, 1500).add(dust).toString());
    const toKeeper = estate.sub(toHeirs).sub(bps(estate, 3500)).sub(bps(estate, 1500));
    expect((await credit(bob.publicKey)).sub(bobCredit0).toString()).to.equal(toKeeper.toString());
    const c = await creature(first);
    expect(c.status).to.equal(STATUS_DEAD);
    expect(c.vault.toNumber()).to.equal(0);
    expect(c.deathTick.toNumber()).to.equal(300);
    expect(w0.totalAlive.sub(w.totalAlive).toNumber()).to.equal(1);
    await expectError(settleDeath(first, CAUSE_STARVED, [], bob.publicKey), "WrongStatus");
    await assertSolvent("death");
  });

  it("a dead parent's royalty falls to the pool", async () => {
    const orphan = await newborn(SOL(0.1), first, 2);
    const w0 = await world();
    await buy(orphan, SOL(0.1), alice, first);
    const w = await world();
    expect(w.pool.sub(w0.pool).toString()).to.equal(SOL(0.025).toString());
    expect((await creature(first)).vault.toNumber()).to.equal(0);
  });

  it("no heirs and no keeper: the estate goes to the treasuries", async () => {
    const wild = await newborn(SOL(0.1));
    await program.methods
      .rewardMany([new BN(50_000)])
      .accountsPartial({ world: worldPda, operator })
      .remainingAccounts(remaining([creaturePda(wild)]))
      .rpc();
    const w0 = await world();
    await settleDeath(wild, CAUSE_STARVED, [], null);
    const w = await world();
    expect(w.metabolism.sub(w0.metabolism).toNumber()).to.equal(20_000 + 17_500 + 5_000);
    expect(w.pool.sub(w0.pool).toNumber()).to.equal(7_500);
    await assertSolvent("wild death");
  });

  it("a cull pays the keeper 85 percent of the vault", async () => {
    const id = await newborn(SOL(1));
    await buy(id, SOL(1), alice);
    await program.methods
      .list(id, SOL(5))
      .accountsPartial({ keeper: alice.publicKey, creature: creaturePda(id) })
      .signers([alice])
      .rpc();
    await program.methods
      .requestCull(id)
      .accountsPartial({ world: worldPda, keeper: alice.publicKey, creature: creaturePda(id) })
      .signers([alice])
      .rpc();
    const c = await creature(id);
    expect(c.pendingCull).to.be.true;
    expect(c.salePrice.toNumber(), "a cull request clears the listing").to.equal(0);
    // a cull cannot be cancelled, so the larva can no longer be sold or handed on
    await expectError(
      program.methods
        .list(id, SOL(5))
        .accountsPartial({ keeper: alice.publicKey, creature: creaturePda(id) })
        .signers([alice])
        .rpc(),
      "WrongStatus"
    );
    await expectError(
      program.methods
        .transfer(id, bob.publicKey)
        .accountsPartial({ keeper: alice.publicKey, creature: creaturePda(id) })
        .signers([alice])
        .rpc(),
      "WrongStatus"
    );
    const vault = c.vault;
    const credit0 = await credit(alice.publicKey);
    const w0 = await world();
    await settleDeath(id, CAUSE_CULLED, [], alice.publicKey);
    expect((await credit(alice.publicKey)).sub(credit0).toString()).to.equal(bps(vault, 8500).toString());
    expect((await world()).metabolism.sub(w0.metabolism).toString()).to.equal(vault.sub(bps(vault, 8500)).toString());
    await assertSolvent("cull");
  });

  it("cause 6 without a request is an ordinary death", async () => {
    const id = await newborn(SOL(1));
    await buy(id, SOL(1), alice);
    const credit0 = await credit(alice.publicKey);
    await settleDeath(id, CAUSE_CULLED, [], alice.publicKey);
    expect((await credit(alice.publicKey)).sub(credit0).toString()).to.equal(SOL(0.06).toString());
  });

  it("transfer hands the larva over, clears the listing, and DEAD is not transferable", async () => {
    const id = await newborn(SOL(0.3));
    await buy(id, SOL(0.3), alice);
    await program.methods
      .list(id, SOL(9))
      .accountsPartial({ keeper: alice.publicKey, creature: creaturePda(id) })
      .signers([alice])
      .rpc();
    await expectError(
      program.methods
        .transfer(id, alice.publicKey)
        .accountsPartial({ keeper: bob.publicKey, creature: creaturePda(id) })
        .signers([bob])
        .rpc(),
      "NotKeeper"
    );
    await program.methods
      .transfer(id, bob.publicKey)
      .accountsPartial({ keeper: alice.publicKey, creature: creaturePda(id) })
      .signers([alice])
      .rpc();
    const c = await creature(id);
    expect(c.keeper.equals(bob.publicKey)).to.be.true;
    expect(c.salePrice.toNumber()).to.equal(0);
    expect(c.vault.toString(), "the vault goes with it").to.equal(SOL(0.18).toString());
    await settleDeath(id, CAUSE_STARVED, [], bob.publicKey);
    await expectError(
      program.methods
        .transfer(id, alice.publicKey)
        .accountsPartial({ keeper: bob.publicKey, creature: creaturePda(id) })
        .signers([bob])
        .rpc(),
      "WrongStatus"
    );
    await assertSolvent("transfer");
  });

  it("post_epoch is strictly monotonic", async () => {
    const hash = Array.from(Buffer.alloc(32, 7));
    await program.methods.postEpoch(new BN(1), new BN(2400), hash).accountsPartial({ world: worldPda, operator }).rpc();
    const w = await world();
    expect(w.lastEpoch.toNumber()).to.equal(1);
    expect(w.lastEpochTick.toNumber()).to.equal(2400);
    expect(Buffer.from(w.lastStateHash).equals(Buffer.alloc(32, 7))).to.be.true;
    await expectError(
      program.methods.postEpoch(new BN(1), new BN(4800), hash).accountsPartial({ world: worldPda, operator }).rpc(),
      "EpochNotMonotonic"
    );
    await expectError(
      program.methods.postEpoch(new BN(2), new BN(2400), hash).accountsPartial({ world: worldPda, operator }).rpc(),
      "EpochNotMonotonic"
    );
    await expectError(
      program.methods.postEpoch(new BN(3), new BN(7200), hash).accountsPartial({ world: worldPda, operator }).rpc(),
      "EpochNotMonotonic"
    );
  });

  it("only the operator settles, births, offers, rewards", async () => {
    const id = (await world()).nextId;
    await expectError(
      program.methods
        .registerBirth(id, NO_PARENT, 0, new BN(1), Array.from(Buffer.alloc(32)))
        .accountsPartial({ world: worldPda, operator: alice.publicKey, creature: creaturePda(id) })
        .signers([alice])
        .rpc(),
      "NotOperator"
    );
    await expectError(
      program.methods
        .openOffer(aliceKept, SOL(1))
        .accountsPartial({ world: worldPda, operator: alice.publicKey, creature: creaturePda(aliceKept) })
        .signers([alice])
        .rpc(),
      "NotOperator"
    );
    await expectError(
      program.methods
        .settleDeath(aliceKept, CAUSE_STARVED, new BN(1), 0)
        .accountsPartial({
          world: worldPda,
          operator: alice.publicKey,
          creature: creaturePda(aliceKept),
          keeperCredit: creditPda(alice.publicKey),
        })
        .signers([alice])
        .rpc(),
      "NotOperator"
    );
    await expectError(
      program.methods
        .rewardMany([new BN(1)])
        .accountsPartial({ world: worldPda, operator: alice.publicKey })
        .remainingAccounts(remaining([creaturePda(aliceKept)]))
        .signers([alice])
        .rpc(),
      "NotOperator"
    );
    await expectError(
      program.methods
        .withdrawTreasury(TAKE_ALL, TAKE_ALL)
        .accountsPartial({ world: worldPda, operator: alice.publicKey, to: alice.publicKey })
        .signers([alice])
        .rpc(),
      "NotOperator"
    );
  });

  it("the treasuries are recoverable by the operator, and fund() feeds them", async () => {
    const w0 = await world();
    expect(w0.metabolism.gtn(0) && w0.pool.gtn(0)).to.be.true;
    // 0 means none of that pot: the pool can be drawn without touching metabolism
    await program.methods
      .withdrawTreasury(new BN(0), TAKE_ALL)
      .accountsPartial({ world: worldPda, operator, to: sink.publicKey })
      .rpc();
    expect((await lamports(sink.publicKey)).toString()).to.equal(w0.pool.toString());
    expect((await world()).metabolism.toString()).to.equal(w0.metabolism.toString());
    await program.methods
      .withdrawTreasury(TAKE_ALL, TAKE_ALL)
      .accountsPartial({ world: worldPda, operator, to: sink.publicKey })
      .rpc();
    expect((await lamports(sink.publicKey)).toString()).to.equal(w0.metabolism.add(w0.pool).toString());
    const w1 = await world();
    expect(w1.metabolism.toNumber()).to.equal(0);
    expect(w1.pool.toNumber()).to.equal(0);
    await assertSolvent("treasury withdrawn");
    await expectError(
      program.methods
        .withdrawTreasury(TAKE_ALL, TAKE_ALL)
        .accountsPartial({ world: worldPda, operator, to: sink.publicKey })
        .rpc(),
      "NothingToWithdraw"
    );

    await program.methods
      .fund(SOL(1), 2500)
      .accountsPartial({ world: worldPda, payer: stranger.publicKey })
      .signers([stranger])
      .rpc();
    const w2 = await world();
    expect(w2.pool.toString()).to.equal(SOL(0.25).toString());
    expect(w2.metabolism.toString()).to.equal(SOL(0.75).toString());
    await expectError(
      program.methods
        .fund(SOL(1), 10_001)
        .accountsPartial({ world: worldPda, payer: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "WrongPrice"
    );
    await program.methods
      .withdrawTreasury(SOL(0.5), SOL(0.05))
      .accountsPartial({ world: worldPda, operator, to: sink.publicKey })
      .rpc();
    const w3 = await world();
    expect(w3.metabolism.toString()).to.equal(SOL(0.25).toString());
    expect(w3.pool.toString()).to.equal(SOL(0.2).toString());
    await assertSolvent("fund");
  });

  it("operator hand-over is a two-step accept", async () => {
    await program.methods.transferOperator(bob.publicKey).accountsPartial({ world: worldPda, operator }).rpc();
    expect((await world()).operator.equals(operator), "nothing changes until accepted").to.be.true;
    await expectError(
      program.methods
        .acceptOperator()
        .accountsPartial({ world: worldPda, pendingOperator: alice.publicKey })
        .signers([alice])
        .rpc(),
      "NotOperator"
    );
    await program.methods
      .acceptOperator()
      .accountsPartial({ world: worldPda, pendingOperator: bob.publicKey })
      .signers([bob])
      .rpc();
    expect((await world()).operator.equals(bob.publicKey)).to.be.true;
    await expectError(program.methods.heartbeat().accountsPartial({ world: worldPda, operator }).rpc(), "NotOperator");
    await program.methods
      .heartbeat()
      .accountsPartial({ world: worldPda, operator: bob.publicKey })
      .signers([bob])
      .rpc();
    await program.methods
      .transferOperator(operator)
      .accountsPartial({ world: worldPda, operator: bob.publicKey })
      .signers([bob])
      .rpc();
    await program.methods.acceptOperator().accountsPartial({ world: worldPda, pendingOperator: operator }).rpc();
    expect((await world()).operator.equals(operator)).to.be.true;
  });

  it("set_recovery only while the operator is alive and the world runs", async () => {
    await program.methods.setRecovery(sink.publicKey).accountsPartial({ world: worldPda, operator }).rpc();
    expect((await world()).recovery.equals(sink.publicKey)).to.be.true;
    await program.methods.setRecovery(recovery.publicKey).accountsPartial({ world: worldPda, operator }).rpc();
    expect((await world()).recovery.equals(recovery.publicKey)).to.be.true;
  });

  it("a running world cannot be wound down by a stranger", async () => {
    await expectError(
      program.methods
        .beginWindDown()
        .accountsPartial({ world: worldPda, signer: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "NotAbandoned"
    );
    expect((await world()).windDown).to.be.false;
  });

  it("an ignored cull becomes self-service after CULL_TIMEOUT", async () => {
    const id = await newborn(SOL(1));
    await buy(id, SOL(1), alice);
    const vault = (await creature(id)).vault;
    await program.methods
      .requestCull(id)
      .accountsPartial({ world: worldPda, keeper: alice.publicKey, creature: creaturePda(id) })
      .signers([alice])
      .rpc();
    const force = (payer: Keypair) =>
      program.methods
        .forceSettleCull(id)
        .accountsPartial({
          world: worldPda,
          payer: payer.publicKey,
          creature: creaturePda(id),
          keeperCredit: creditPda(alice.publicKey),
        })
        .signers([payer])
        .rpc();
    await expectError(force(alice), "TooEarly");
    await sleep(CULL_TIMEOUT_S + 2);
    const credit0 = await credit(alice.publicKey);
    const w0 = await world();
    // the operator never came; a stranger presses it and the keeper is paid
    await force(stranger);
    expect((await credit(alice.publicKey)).sub(credit0).toString()).to.equal(bps(vault, 8500).toString());
    expect((await world()).metabolism.sub(w0.metabolism).toString()).to.equal(vault.sub(bps(vault, 8500)).toString());
    expect((await creature(id)).status).to.equal(STATUS_DEAD);
    const before = await lamports(alice.publicKey);
    await withdraw(alice);
    expect((await lamports(alice.publicKey)).sub(before).toString()).to.equal(credit0.add(bps(vault, 8500)).toString());
    await assertSolvent("force cull");
  });

  it("operator activity keeps the world alive", async () => {
    // an unkept larva for the escheat drill, bought by a keeper who will
    // never be seen again
    charlieKept = await newborn(SOL(0.5));
    await buy(charlieKept, SOL(0.5), charlie);
    await sleep(ABANDONED_AFTER_S - 1);
    await program.methods.heartbeat().accountsPartial({ world: worldPda, operator }).rpc();
    await sleep(2);
    await expectError(
      program.methods
        .beginWindDown()
        .accountsPartial({ world: worldPda, signer: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "NotAbandoned"
    );
    await program.methods.heartbeat().accountsPartial({ world: worldPda, operator }).rpc();
  });

  it("keeper recovers the vault with the operator gone forever", async () => {
    // the operator never acts again from this line on
    const vault = (await creature(aliceKept)).vault;
    expect(vault.gtn(0), "the larva holds money").to.be.true;
    await expectError(
      program.methods
        .reclaimVault(aliceKept)
        .accountsPartial({
          world: worldPda,
          keeper: alice.publicKey,
          creature: creaturePda(aliceKept),
          credit: creditPda(alice.publicKey),
        })
        .signers([alice])
        .rpc(),
      "NotWindingDown"
    );
    await sleep(ABANDONED_AFTER_S + 2);

    // a total stranger can open the exits; that is the point
    await program.methods
      .beginWindDown()
      .accountsPartial({ world: worldPda, signer: stranger.publicKey })
      .signers([stranger])
      .rpc();
    const w = await world();
    expect(w.windDown).to.be.true;
    expect(w.windDownAt.toNumber()).to.be.greaterThan(0);
    // the last resort is not open yet: six months on a real build
    await expectError(
      program.methods.escheat().accountsPartial({ world: worldPda, recovery: recovery.publicKey }).rpc(),
      "TooEarly"
    );
    await expectError(
      program.methods
        .beginWindDown()
        .accountsPartial({ world: worldPda, signer: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "WrongStatus"
    );
    await expectError(
      program.methods.setRecovery(sink.publicKey).accountsPartial({ world: worldPda, operator }).rpc(),
      "WrongStatus"
    );

    // only the keeper reclaims their own larva
    await expectError(
      program.methods
        .reclaimVault(aliceKept)
        .accountsPartial({
          world: worldPda,
          keeper: bob.publicKey,
          creature: creaturePda(aliceKept),
          credit: creditPda(bob.publicKey),
        })
        .signers([bob])
        .rpc(),
      "NotKeeper"
    );
    await program.methods
      .reclaimVault(aliceKept)
      .accountsPartial({
        world: worldPda,
        keeper: alice.publicKey,
        creature: creaturePda(aliceKept),
        credit: creditPda(alice.publicKey),
      })
      .signers([alice])
      .rpc();
    const before = await lamports(alice.publicKey);
    await withdraw(alice);
    expect((await lamports(alice.publicKey)).sub(before).toString(), "keeper got the whole vault").to.equal(vault.toString());
    const c = await creature(aliceKept);
    expect(c.vault.toNumber()).to.equal(0);
    expect(c.status).to.equal(STATUS_DEAD);
    await assertSolvent("reclaim");
  });

  it("treasuries reach recovery without the operator, and only recovery", async () => {
    const w0 = await world();
    const treasury = w0.metabolism.add(w0.pool);
    expect(treasury.gtn(0)).to.be.true;
    await expectError(
      program.methods
        .sweepToRecovery()
        .accountsPartial({ world: worldPda, recovery: stranger.publicKey })
        .rpc(),
      "WrongId"
    );
    const before = await lamports(recovery.publicKey);
    await program.methods.sweepToRecovery().accountsPartial({ world: worldPda, recovery: recovery.publicKey }).rpc();
    expect((await lamports(recovery.publicKey)).sub(before).toString()).to.equal(treasury.toString());
    const w = await world();
    expect(w.metabolism.toNumber()).to.equal(0);
    expect(w.pool.toNumber()).to.equal(0);
    await assertSolvent("sweep");
  });

  it("a world that is winding down takes no new money", async () => {
    const id = (await world()).nextId;
    await expectError(
      program.methods
        .registerBirth(id, NO_PARENT, 0, new BN(100), Array.from(Buffer.alloc(32, 1)))
        .accountsPartial({ world: worldPda, operator, creature: creaturePda(id) })
        .rpc(),
      "WindingDown"
    );
    await expectError(
      program.methods
        .fund(SOL(1), 5000)
        .accountsPartial({ world: worldPda, payer: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "WindingDown"
    );
    await expectError(
      program.methods
        .rewardMany([new BN(1)])
        .accountsPartial({ world: worldPda, operator })
        .remainingAccounts(remaining([creaturePda(charlieKept)]))
        .rpc(),
      "WindingDown"
    );
    // a listed larva stays listed, but nobody can buy into a closing world
    const listed = (await program.account.creature.all()).find((c) => c.account.status === STATUS_OWNED && c.account.salePrice.gtn(0));
    if (listed) {
      await expectError(
        program.methods
          .buyListed(listed.account.id, listed.account.salePrice)
          .accountsPartial({
            world: worldPda,
            buyer: stranger.publicKey,
            creature: creaturePda(listed.account.id),
            sellerCredit: creditPda(listed.account.keeper),
          })
          .signers([stranger])
          .rpc(),
        "WindingDown"
      );
    }
  });

  it("nothing is left behind when the world ends, except what nobody came back for", async () => {
    const all = await program.account.creature.all();
    for (const { account: c } of all) {
      if (c.vault.isZero() || c.keeper.equals(charlie.publicKey)) continue;
      const keeper = c.keeper.equals(alice.publicKey) ? alice : bob;
      expect(c.keeper.equals(keeper.publicKey), `creature ${c.id} has a reachable keeper`).to.be.true;
      await program.methods
        .reclaimVault(c.id)
        .accountsPartial({
          world: worldPda,
          keeper: keeper.publicKey,
          creature: creaturePda(c.id),
          credit: creditPda(keeper.publicKey),
        })
        .signers([keeper])
        .rpc();
    }
    for (const who of [alice, bob]) {
      if ((await credit(who.publicKey)).gtn(0)) await withdraw(who);
    }
    const w = await world();
    const info = await conn.getAccountInfo(worldPda);
    const rent = await conn.getMinimumBalanceForRentExemption(info!.data.length);
    const left = new BN(info!.lamports - rent);
    const unclaimed = (await creature(charlieKept)).vault;
    expect(unclaimed.gtn(0)).to.be.true;
    expect(w.totalCredit.toNumber()).to.equal(0);
    expect(w.metabolism.toNumber()).to.equal(0);
    expect(w.pool.toNumber()).to.equal(0);
    expect(w.totalVaults.toString()).to.equal(unclaimed.toString());
    expect(left.toString(), "the world holds exactly the one vault nobody reclaimed").to.equal(unclaimed.toString());
    await assertSolvent("emptied");
  });

  it("unclaimed funds escheat to recovery after ESCHEAT_AFTER", async () => {
    const escheat = () =>
      program.methods.escheat().accountsPartial({ world: worldPda, recovery: recovery.publicKey }).rpc();
    // wait out whatever is left of the timer on the validator's own clock
    const opensAt = (await world()).windDownAt.toNumber() + ESCHEAT_AFTER_S;
    const chainNow = (await conn.getBlockTime(await conn.getSlot())) ?? Math.floor(Date.now() / 1000);
    await sleep(Math.max(0, opensAt - chainNow) + 2);
    const info = await conn.getAccountInfo(worldPda);
    const rent = await conn.getMinimumBalanceForRentExemption(info!.data.length);
    const stuck = new BN(info!.lamports - rent);
    expect(stuck.gtn(0)).to.be.true;
    const before = await lamports(recovery.publicKey);
    await escheat();
    expect((await lamports(recovery.publicKey)).sub(before).toString(), "every last lamport reached recovery").to.equal(
      stuck.toString()
    );
    expect((await lamports(worldPda)).toNumber(), "the world keeps only its rent").to.equal(rent);
    const w = await world();
    expect(w.totalVaults.toNumber()).to.equal(0);
    await assertSolvent("escheat", false);
    // the late keeper's claim is now honestly refused
    await expectError(
      program.methods
        .reclaimVault(charlieKept)
        .accountsPartial({
          world: worldPda,
          keeper: charlie.publicKey,
          creature: creaturePda(charlieKept),
          credit: creditPda(charlie.publicKey),
        })
        .signers([charlie])
        .rpc(),
      "Insolvent"
    );
  });

  it("the record is permanent: every larva ever born is still readable", async () => {
    const w = await world();
    const all = await program.account.creature.all();
    expect(all.length).to.equal(w.nextId.toNumber());
    const statuses = new Set(all.map((c) => c.account.status));
    for (const s of statuses) expect([STATUS_OFFERED, STATUS_OWNED, STATUS_WILD, STATUS_DEAD]).to.include(s);
  });
});
