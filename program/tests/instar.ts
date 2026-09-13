// End-to-end suite against `anchor test`'s local validator. The program is
// built with the `short-timers` feature so the recovery drills wait their
// timers out in real time (ABANDONED_AFTER = ESCHEAT_AFTER = 4 s,
// CULL_TIMEOUT = 3 s, LISTING_MAX_AGE = 6 s). Everything runs against one
// World, so the order of the tests is the order of the world's life: market,
// deaths, administration, and finally the operator vanishing. Every larva is
// a Metaplex Core asset in the world's collection; the validator preloads
// Core from program/deps.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { burnV1, fetchAsset, fetchCollection, mplCore, transferV1 } from "@metaplex-foundation/mpl-core";
import { keypairIdentity } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsKeypair, fromWeb3JsPublicKey, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import type { Instar } from "../target/types/instar.ts";

const ABANDONED_AFTER_S = 4;
const ESCHEAT_AFTER_S = 4;
const CULL_TIMEOUT_S = 3;
const LISTING_MAX_AGE_S = 6;

const NO_PARENT = new BN("18446744073709551615");
const TAKE_ALL = new BN("18446744073709551615");
const STATUS_OFFERED = 1;
const STATUS_OWNED = 2;
const STATUS_WILD = 3;
const STATUS_DEAD = 4;
const CAUSE_STARVED = 1;
const CAUSE_CULLED = 6;
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const COLLECTION_URI = "https://instar.test/api/collection.json";
const larvaUri = (id: BN) => `https://instar.test/api/larva/${id.toString()}.json`;

const SOL = (n: number) => new BN(Math.round(n * LAMPORTS_PER_SOL));
const bps = (amount: BN, share: number) => amount.muln(share).divn(10_000);
const sleep = (s: number) => delay(s * 1000);

describe("instar", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.instar as Program<Instar>;
  const conn = provider.connection;
  const operator = provider.wallet.publicKey;
  const umi = createUmi(conn.rpcEndpoint, "processed").use(mplCore());

  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const charlie = Keypair.generate(); // a keeper who loses their key
  const stranger = Keypair.generate();
  const recovery = Keypair.generate();
  const sink = Keypair.generate();
  const collection = Keypair.generate();

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

  /// The Core accounts every asset-touching instruction takes.
  const assetOf = async (id: BN) => (await creature(id)).asset;
  const core = async (id: BN) => ({ asset: await assetOf(id), collection: collection.publicKey, mplCoreProgram: MPL_CORE });
  const asset = async (id: BN) => fetchAsset(umi, fromWeb3JsPublicKey(await assetOf(id)), { skipDerivePlugins: true });
  const ownerOf = async (id: BN) => toWeb3JsPublicKey((await asset(id)).owner);
  /// A burned Core asset is not deleted: Core leaves a one-byte Uninitialized
  /// stub it still owns (null only if something else closed the account).
  const assetBurned = async (id: BN) => {
    const info = await conn.getAccountInfo(await assetOf(id));
    return info === null || (info.data.length === 1 && info.data[0] === 0);
  };

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

  async function expectRejected(p: Promise<unknown>, label: string) {
    let rejected = false;
    await p.catch(() => (rejected = true));
    if (!rejected) throw new Error(`${label}: expected the transaction to fail, but it succeeded`);
  }

  async function openOffer(id: BN, price: BN) {
    await program.methods
      .openOffer(id, price)
      .accountsPartial({ world: worldPda, operator, creature: creaturePda(id), asset: await assetOf(id) })
      .rpc();
  }

  async function newborn(price: BN, parentId: BN = NO_PARENT, generation = 0): Promise<BN> {
    const id = (await world()).nextId;
    const assetKey = Keypair.generate();
    await program.methods
      .registerBirth(id, parentId, generation, new BN(100), Array.from(Buffer.alloc(32, 1)), larvaUri(id))
      .accountsPartial({
        world: worldPda,
        operator,
        creature: creaturePda(id),
        asset: assetKey.publicKey,
        collection: collection.publicKey,
        mplCoreProgram: MPL_CORE,
      })
      .signers([assetKey])
      .rpc();
    await openOffer(id, price);
    return id;
  }

  async function buy(id: BN, price: BN, buyer: Keypair, parent: BN | null = null, assetKey?: PublicKey) {
    await program.methods
      .buy(id, price)
      .accountsPartial({
        world: worldPda,
        buyer: buyer.publicKey,
        creature: creaturePda(id),
        parent: parent ? creaturePda(parent) : null,
        asset: assetKey ?? (await assetOf(id)),
        collection: collection.publicKey,
        mplCoreProgram: MPL_CORE,
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
        ...(await core(id)),
        keeperCredit: keeper ? creditPda(keeper) : null,
      })
      .remainingAccounts(remaining(heirs.map(creaturePda)))
      .rpc();
  }

  async function list(id: BN, price: BN, signer: Keypair) {
    await program.methods
      .list(id, price)
      .accountsPartial({ signer: signer.publicKey, creature: creaturePda(id), asset: await assetOf(id) })
      .signers([signer])
      .rpc();
  }

  async function unlist(id: BN, signer: Keypair) {
    await program.methods
      .unlist(id)
      .accountsPartial({ signer: signer.publicKey, creature: creaturePda(id), asset: await assetOf(id) })
      .signers([signer])
      .rpc();
  }

  // The seller's credit is derived from the record, as any client would: the
  // program pays whoever listed the larva, and refuses when nobody did.
  async function buyListed(id: BN, price: BN, buyer: Keypair) {
    await program.methods
      .buyListed(id, price)
      .accountsPartial({
        world: worldPda,
        buyer: buyer.publicKey,
        creature: creaturePda(id),
        ...(await core(id)),
        sellerCredit: creditPda((await creature(id)).listedBy),
      })
      .signers([buyer])
      .rpc();
  }

  async function requestCull(id: BN, owner: Keypair) {
    await program.methods
      .requestCull(id)
      .accountsPartial({ world: worldPda, owner: owner.publicKey, creature: creaturePda(id), ...(await core(id)) })
      .signers([owner])
      .rpc();
  }

  async function reclaimVault(id: BN, owner: Keypair) {
    await program.methods
      .reclaimVault(id)
      .accountsPartial({
        world: worldPda,
        owner: owner.publicKey,
        creature: creaturePda(id),
        ...(await core(id)),
        credit: creditPda(owner.publicKey),
      })
      .signers([owner])
      .rpc();
  }

  /// What a wallet does: a plain Core transfer or burn signed by the asset's
  /// owner, with no Instar instruction involved.
  async function nativeTransfer(id: BN, from: Keypair, to: PublicKey) {
    const u = createUmi(conn.rpcEndpoint, "processed").use(mplCore()).use(keypairIdentity(fromWeb3JsKeypair(from)));
    await transferV1(u, {
      asset: fromWeb3JsPublicKey(await assetOf(id)),
      collection: fromWeb3JsPublicKey(collection.publicKey),
      newOwner: fromWeb3JsPublicKey(to),
    }).sendAndConfirm(u);
  }
  async function nativeBurn(id: BN, owner: Keypair) {
    const u = createUmi(conn.rpcEndpoint, "processed").use(mplCore()).use(keypairIdentity(fromWeb3JsKeypair(owner)));
    await burnV1(u, {
      asset: fromWeb3JsPublicKey(await assetOf(id)),
      collection: fromWeb3JsPublicKey(collection.publicKey),
    }).sendAndConfirm(u);
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
      .initWorld(recoveryKey, COLLECTION_URI)
      .accountsPartial({
        world: worldPda,
        operator: signer ? signer.publicKey : operator,
        collection: collection.publicKey,
        program: program.programId,
        programData: programDataPda,
        mplCoreProgram: MPL_CORE,
      })
      .signers(signer ? [signer, collection] : [collection])
      .rpc();

  it("only the upgrade authority can create the world, and never with itself as recovery", async () => {
    await expectError(initWorld(recovery.publicKey, stranger), "NotOperator");
    await expectError(initWorld(operator), "RecoveryIsOperator");
    await expectError(initWorld(PublicKey.default), "WrongId");
  });

  it("init_world fixes the recovery address and creates the collection the World controls", async () => {
    await initWorld(recovery.publicKey);
    const w = await world();
    expect(w.operator.equals(operator)).to.be.true;
    expect(w.recovery.equals(recovery.publicKey)).to.be.true;
    expect(w.collection.equals(collection.publicKey)).to.be.true;
    expect(w.windDown).to.be.false;
    expect(w.nextId.toNumber()).to.equal(0);
    expect(w.lastOperatorAction.toNumber()).to.be.greaterThan(0);
    const coll = await fetchCollection(umi, fromWeb3JsPublicKey(collection.publicKey));
    expect(coll.name).to.equal("Instar");
    expect(coll.uri).to.equal(COLLECTION_URI);
    expect(toWeb3JsPublicKey(coll.updateAuthority).equals(worldPda), "the World PDA is the collection authority").to.be.true;
    expect(coll.numMinted).to.equal(0);
    await assertSolvent("init");
  });

  it("you cannot buy an id that was never born", async () => {
    const nobody = Keypair.generate().publicKey;
    await expectError(buy(new BN(999_999), SOL(0), alice, null, nobody), "AccountNotInitialized");
    const next = (await world()).nextId;
    await expectError(buy(next, SOL(0), alice, null, nobody), "AccountNotInitialized");
  });

  it("register_birth requires the next id in sequence", async () => {
    const id = (await world()).nextId;
    const wrong = id.addn(1);
    const assetKey = Keypair.generate();
    await expectError(
      program.methods
        .registerBirth(wrong, NO_PARENT, 0, new BN(1), Array.from(Buffer.alloc(32)), larvaUri(wrong))
        .accountsPartial({
          world: worldPda,
          operator,
          creature: creaturePda(wrong),
          asset: assetKey.publicKey,
          collection: collection.publicKey,
          mplCoreProgram: MPL_CORE,
        })
        .signers([assetKey])
        .rpc(),
      "WrongId"
    );
  });

  it("a birth mints the larva's asset to the World PDA, in the collection, with its record as attributes", async () => {
    first = await newborn(SOL(1));
    const c = await creature(first);
    expect(c.status).to.equal(STATUS_OFFERED);
    const a = await asset(first);
    expect(a.name).to.equal(`Instar #${first.toString()}`);
    expect(a.uri).to.equal(larvaUri(first));
    expect(toWeb3JsPublicKey(a.owner).equals(worldPda), "the dish holds an unsold larva").to.be.true;
    expect(a.updateAuthority.type).to.equal("Collection");
    expect(toWeb3JsPublicKey(a.updateAuthority.address!).equals(collection.publicKey)).to.be.true;
    const attributes = Object.fromEntries((a.attributes?.attributeList ?? []).map((x) => [x.key, x.value]));
    expect(attributes).to.deep.equal({ generation: "0", parent: "founder", birth_tick: "100", genome: "0101010101010101" });
    expect(a.permanentFreezeDelegate?.frozen).to.be.false;
    expect(a.permanentTransferDelegate, "the World can move it").to.not.be.undefined;
    expect(a.permanentBurnDelegate, "the World can burn it").to.not.be.undefined;
    for (const plugin of [a.permanentFreezeDelegate, a.permanentTransferDelegate, a.permanentBurnDelegate, a.attributes]) {
      expect(plugin!.authority.type).to.equal("Address");
      expect(toWeb3JsPublicKey(plugin!.authority.address!).equals(worldPda)).to.be.true;
    }
    expect((await fetchCollection(umi, fromWeb3JsPublicKey(collection.publicKey))).numMinted).to.equal(1);
  });

  it("buy splits 60/15/15, the parentless royalty falls to the pool, and the asset moves to the buyer", async () => {
    const before = await lamports(worldPda);
    await buy(first, SOL(1), alice);
    const c = await creature(first);
    const w = await world();
    expect((await ownerOf(first)).equals(alice.publicKey), "alice owns the asset").to.be.true;
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

  it("the asset account must be the larva's own", async () => {
    await expectError(
      program.methods
        .list(first, SOL(2))
        .accountsPartial({ signer: alice.publicKey, creature: creaturePda(first), asset: await assetOf(aliceKept) })
        .signers([alice])
        .rpc(),
      "AssetMismatch"
    );
  });

  it("resale pays the seller 90 percent, the vault travels, and the delegate moves the asset", async () => {
    await list(first, SOL(2), alice);
    const listed = await creature(first);
    expect(listed.salePrice.toString()).to.equal(SOL(2).toString());
    expect(listed.listedBy.equals(alice.publicKey)).to.be.true;
    await expectError(list(first, SOL(2), bob), "NotOwner");
    const w0 = await world();
    await buyListed(first, SOL(2), bob);
    const c = await creature(first);
    const w = await world();
    expect((await ownerOf(first)).equals(bob.publicKey), "bob owns the asset").to.be.true;
    expect(c.salePrice.toNumber()).to.equal(0);
    expect(c.listedBy.equals(PublicKey.default)).to.be.true;
    expect(c.vault.toString(), "vault travelled untouched").to.equal(SOL(0.6).toString());
    expect((await credit(alice.publicKey)).toString()).to.equal(SOL(1.8).toString());
    expect(w.metabolism.sub(w0.metabolism).toString()).to.equal(SOL(0.1).toString());
    expect(w.pool.sub(w0.pool).toString()).to.equal(SOL(0.1).toString());
    await assertSolvent("resale");
  });

  it("unlisted larvae are not for sale", async () => {
    await list(first, SOL(3), bob);
    await unlist(first, bob);
    await expectError(buyListed(first, SOL(3), alice), "NotForSale");
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
    const attributes = Object.fromEntries(((await asset(child)).attributes?.attributeList ?? []).map((x) => [x.key, x.value]));
    expect(attributes.parent).to.equal(first.toString());
    expect(attributes.generation).to.equal("1");
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

  it("death pays the heirs 40 percent in equal shares, dust to the pool, and burns the asset", async () => {
    const heirs = [await newborn(SOL(0.2)), await newborn(SOL(0.2)), await newborn(SOL(0.2))];
    for (const h of heirs) await buy(h, SOL(0.2), bob);
    const estate = (await creature(first)).vault;
    expect(estate.toString()).to.equal(SOL(0.61).toString());
    const h0 = await Promise.all(heirs.map(creature));
    const w0 = await world();
    const bobCredit0 = await credit(bob.publicKey);
    const assetKey = await assetOf(first);
    const assetRent = (await conn.getAccountInfo(assetKey))!.lamports;
    const operatorBefore = await lamports(operator);

    // the credit account is the wrong keeper's: bob owns the asset now, not alice
    await expectError(settleDeath(first, CAUSE_STARVED, heirs, alice.publicKey), "ConstraintSeeds");
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
    expect((await credit(bob.publicKey)).sub(bobCredit0).toString(), "the owner at death is paid").to.equal(toKeeper.toString());
    const c = await creature(first);
    expect(c.status).to.equal(STATUS_DEAD);
    expect(c.vault.toNumber()).to.equal(0);
    expect(c.deathTick.toNumber()).to.equal(300);
    expect(c.asset.equals(assetKey), "the record keeps the asset address").to.be.true;
    expect(await assetBurned(first), "the asset is burned").to.be.true;
    expect((await lamports(operator)).gt(operatorBefore.subn(20_000)), "the burn refunds the asset rent to the operator").to.be.true;
    expect(assetRent).to.be.greaterThan(0);
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

  it("no heirs and no keeper: the estate goes to the treasuries and the World burns its own asset", async () => {
    const wild = await newborn(SOL(0.1));
    expect((await ownerOf(wild)).equals(worldPda)).to.be.true;
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
    expect(await assetBurned(wild)).to.be.true;
    await assertSolvent("wild death");
  });

  it("a cull freezes the asset and pays the keeper 85 percent of the vault", async () => {
    const id = await newborn(SOL(1));
    await buy(id, SOL(1), alice);
    await list(id, SOL(5), alice);
    await expectError(requestCull(id, bob), "NotOwner");
    await requestCull(id, alice);
    const c = await creature(id);
    expect(c.pendingCull).to.be.true;
    expect(c.salePrice.toNumber(), "a cull request clears the listing").to.equal(0);
    expect(c.listedBy.equals(PublicKey.default)).to.be.true;
    expect((await asset(id)).permanentFreezeDelegate?.frozen, "the asset is frozen").to.be.true;
    // a cull cannot be cancelled, so the larva can no longer be sold or handed on
    await expectError(list(id, SOL(5), alice), "WrongStatus");
    await expectError(requestCull(id, alice), "WrongStatus");
    await expectRejected(nativeTransfer(id, alice, bob.publicKey), "a frozen asset cannot be moved by its owner");
    expect((await ownerOf(id)).equals(alice.publicKey)).to.be.true;
    const vault = c.vault;
    const credit0 = await credit(alice.publicKey);
    const w0 = await world();
    await settleDeath(id, CAUSE_CULLED, [], alice.publicKey);
    expect((await credit(alice.publicKey)).sub(credit0).toString()).to.equal(bps(vault, 8500).toString());
    expect((await world()).metabolism.sub(w0.metabolism).toString()).to.equal(vault.sub(bps(vault, 8500)).toString());
    expect(await assetBurned(id), "the burn delegate burns through the freeze").to.be.true;
    await assertSolvent("cull");
  });

  it("cause 6 without a request is an ordinary death", async () => {
    const id = await newborn(SOL(1));
    await buy(id, SOL(1), alice);
    const credit0 = await credit(alice.publicKey);
    await settleDeath(id, CAUSE_CULLED, [], alice.publicKey);
    expect((await credit(alice.publicKey)).sub(credit0).toString()).to.equal(SOL(0.06).toString());
  });

  it("a plain Core transfer hands the larva over; the old listing is void and the new owner clears it", async () => {
    const id = await newborn(SOL(0.3));
    await buy(id, SOL(0.3), alice);
    await list(id, SOL(9), alice);
    await expectRejected(nativeTransfer(id, bob, alice.publicKey), "only the owner can move the asset");
    await nativeTransfer(id, alice, bob.publicKey);
    expect((await ownerOf(id)).equals(bob.publicKey)).to.be.true;
    const c = await creature(id);
    expect(c.status).to.equal(STATUS_OWNED);
    expect(c.vault.toString(), "the vault goes with it").to.equal(SOL(0.18).toString());
    expect(c.salePrice.toString(), "the stale listing is still on the record").to.equal(SOL(9).toString());
    // ...but nobody can buy from a seller who no longer holds the asset
    await expectError(buyListed(id, SOL(9), stranger), "NotForSale");
    await expectError(unlist(id, stranger), "NotOwner");
    await unlist(id, bob);
    expect((await creature(id)).salePrice.toNumber()).to.equal(0);
    // the new owner is the keeper: they list, cull and are paid at death
    await list(id, SOL(1), bob);
    expect((await creature(id)).listedBy.equals(bob.publicKey)).to.be.true;
    const bobCredit0 = await credit(bob.publicKey);
    await expectError(settleDeath(id, CAUSE_STARVED, [], alice.publicKey), "ConstraintSeeds");
    await settleDeath(id, CAUSE_STARVED, [], bob.publicKey);
    expect((await credit(bob.publicKey)).sub(bobCredit0).toString()).to.equal(SOL(0.018).toString());
    await assertSolvent("native transfer");
  });

  it("a keeper who burns the asset natively forfeits the keeper share; the death still settles", async () => {
    const id = await newborn(SOL(0.5));
    await buy(id, SOL(0.5), alice);
    await nativeBurn(id, alice);
    expect(await assetBurned(id)).to.be.true;
    const c0 = await creature(id);
    expect(c0.status, "the record cannot see a native burn").to.equal(STATUS_OWNED);
    // nobody owns a burned asset: it cannot be listed, culled or reclaimed...
    await expectError(list(id, SOL(1), alice), "WrongStatus");
    await expectError(requestCull(id, alice), "WrongStatus");
    // ...and there is no keeper to pay, so a credit for the old owner is refused
    await expectError(settleDeath(id, CAUSE_STARVED, [], alice.publicKey), "WrongStatus");
    const w0 = await world();
    const aliceCredit0 = await credit(alice.publicKey);
    await settleDeath(id, CAUSE_STARVED, [], null);
    const w = await world();
    const estate = c0.vault;
    expect(estate.toString()).to.equal(SOL(0.3).toString());
    expect(w.metabolism.sub(w0.metabolism).toString(), "no heirs and no keeper: 40 + 35 + 10 percent").to.equal(
      bps(estate, 4000).add(bps(estate, 3500)).add(bps(estate, 1000)).toString()
    );
    expect(w.pool.sub(w0.pool).toString()).to.equal(bps(estate, 1500).toString());
    expect((await credit(alice.publicKey)).toString(), "the old owner is not paid").to.equal(aliceCredit0.toString());
    expect(w0.totalAlive.sub(w.totalAlive).toNumber()).to.equal(1);
    const c = await creature(id);
    expect(c.status).to.equal(STATUS_DEAD);
    expect(c.vault.toNumber()).to.equal(0);
    await assertSolvent("native burn");
  });

  it("a listing expires after LISTING_MAX_AGE and has to be made again", async () => {
    const id = await newborn(SOL(0.3));
    await buy(id, SOL(0.3), alice);
    await list(id, SOL(1), alice);
    expect((await creature(id)).listedAt.toNumber()).to.be.greaterThan(0);
    await sleep(LISTING_MAX_AGE_S + 2);
    await expectError(buyListed(id, SOL(1), bob), "NotForSale");
    expect((await creature(id)).salePrice.toString(), "the expired listing is still on the record").to.equal(SOL(1).toString());
    await list(id, SOL(1), alice);
    await buyListed(id, SOL(1), bob);
    expect((await ownerOf(id)).equals(bob.publicKey)).to.be.true;
    expect((await creature(id)).listedAt.toNumber(), "the sale clears the listing").to.equal(0);
  });

  it("a larva sent back to the dish is re-offered by the operator and bought again", async () => {
    const id = await newborn(SOL(0.2));
    await buy(id, SOL(0.2), alice);
    await list(id, SOL(4), alice);
    // a larva in a keeper's hands is never the operator's to offer
    await expectError(openOffer(aliceKept, SOL(1)), "WrongStatus");
    await nativeTransfer(id, alice, worldPda);
    expect((await ownerOf(id)).equals(worldPda)).to.be.true;
    await expectError(buy(id, SOL(0.2), bob), "NotForSale");
    await openOffer(id, SOL(0.25));
    const c = await creature(id);
    expect(c.status).to.equal(STATUS_OFFERED);
    expect(c.salePrice.toString()).to.equal(SOL(0.25).toString());
    expect(c.listedBy.equals(PublicKey.default), "the donor's listing is gone").to.be.true;
    await buy(id, SOL(0.25), bob);
    expect((await ownerOf(id)).equals(bob.publicKey)).to.be.true;
    expect((await creature(id)).vault.toString(), "the vault stays with the larva and takes the new seed").to.equal(
      c.vault.add(bps(SOL(0.25), 6000)).toString()
    );
    await assertSolvent("re-offer");
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
    const assetKey = Keypair.generate();
    await expectError(
      program.methods
        .registerBirth(id, NO_PARENT, 0, new BN(1), Array.from(Buffer.alloc(32)), larvaUri(id))
        .accountsPartial({
          world: worldPda,
          operator: alice.publicKey,
          creature: creaturePda(id),
          asset: assetKey.publicKey,
          collection: collection.publicKey,
          mplCoreProgram: MPL_CORE,
        })
        .signers([alice, assetKey])
        .rpc(),
      "NotOperator"
    );
    await expectError(
      program.methods
        .openOffer(aliceKept, SOL(1))
        .accountsPartial({ world: worldPda, operator: alice.publicKey, creature: creaturePda(aliceKept), asset: await assetOf(aliceKept) })
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
          ...(await core(aliceKept)),
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
    await requestCull(id, alice);
    const force = async (payer: Keypair, keeper: PublicKey = alice.publicKey) =>
      program.methods
        .forceSettleCull(id)
        .accountsPartial({
          world: worldPda,
          payer: payer.publicKey,
          creature: creaturePda(id),
          ...(await core(id)),
          keeperCredit: creditPda(keeper),
        })
        .signers([payer])
        .rpc();
    await expectError(force(alice), "TooEarly");
    await sleep(CULL_TIMEOUT_S + 2);
    const credit0 = await credit(alice.publicKey);
    const w0 = await world();
    // the credit must be the asset owner's, whoever presses it
    await expectError(force(stranger, stranger.publicKey), "ConstraintSeeds");
    // the operator never came; a stranger presses it and the keeper is paid
    await force(stranger);
    expect((await credit(alice.publicKey)).sub(credit0).toString()).to.equal(bps(vault, 8500).toString());
    expect((await world()).metabolism.sub(w0.metabolism).toString()).to.equal(vault.sub(bps(vault, 8500)).toString());
    expect((await creature(id)).status).to.equal(STATUS_DEAD);
    expect(await assetBurned(id)).to.be.true;
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
    await expectError(reclaimVault(aliceKept, alice), "NotWindingDown");
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

    // only the asset's owner reclaims their larva
    await expectError(reclaimVault(aliceKept, bob), "NotOwner");
    await reclaimVault(aliceKept, alice);
    const before = await lamports(alice.publicKey);
    await withdraw(alice);
    expect((await lamports(alice.publicKey)).sub(before).toString(), "keeper got the whole vault").to.equal(vault.toString());
    const c = await creature(aliceKept);
    expect(c.vault.toNumber()).to.equal(0);
    expect(c.status).to.equal(STATUS_DEAD);
    expect(await assetBurned(aliceKept), "reclaiming burns the asset").to.be.true;
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
    const assetKey = Keypair.generate();
    await expectError(
      program.methods
        .registerBirth(id, NO_PARENT, 0, new BN(100), Array.from(Buffer.alloc(32, 1)), larvaUri(id))
        .accountsPartial({
          world: worldPda,
          operator,
          creature: creaturePda(id),
          asset: assetKey.publicKey,
          collection: collection.publicKey,
          mplCoreProgram: MPL_CORE,
        })
        .signers([assetKey])
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
      await expectError(buyListed(listed.account.id, listed.account.salePrice, stranger), "WindingDown");
    }
  });

  it("nothing is left behind when the world ends, except what nobody came back for", async () => {
    const all = await program.account.creature.all();
    for (const { account: c } of all) {
      if (c.vault.isZero() || c.id.eq(charlieKept)) continue;
      const owner = await ownerOf(c.id);
      const keeper = owner.equals(alice.publicKey) ? alice : bob;
      expect(owner.equals(keeper.publicKey), `creature ${c.id} has a reachable keeper`).to.be.true;
      await reclaimVault(c.id, keeper);
      expect(await assetBurned(c.id)).to.be.true;
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
    // the late keeper's claim is now honestly refused; their asset is still theirs
    await expectError(reclaimVault(charlieKept, charlie), "Insolvent");
    expect((await ownerOf(charlieKept)).equals(charlie.publicKey)).to.be.true;
  });

  it("the record is permanent: every larva ever born is still readable", async () => {
    const w = await world();
    const all = await program.account.creature.all();
    expect(all.length).to.equal(w.nextId.toNumber());
    const statuses = new Set(all.map((c) => c.account.status));
    for (const s of statuses) expect([STATUS_OFFERED, STATUS_OWNED, STATUS_WILD, STATUS_DEAD]).to.include(s);
    // every DEAD larva's asset is burned; every living one's is a real Core asset
    for (const { account: c } of all) {
      if (c.status === STATUS_DEAD) expect(await assetBurned(c.id), `#${c.id} is burned`).to.be.true;
      else expect((await asset(c.id)).publicKey).to.equal(fromWeb3JsPublicKey(c.asset));
    }
  });
});
