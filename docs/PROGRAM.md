# The Instar program

`program/programs/instar` is the Anchor 0.31 program that holds the permanent
record of the world: every larva's identity and ancestry as a Metaplex Core
asset in the world's collection, the lamports it has earned, the market it
trades in, and the engine's state hash committed every epoch. The simulation
itself runs off-chain in `services/world`; nothing here runs a neuron.

Program id: the keypair at `program/target/deploy/instar-keypair.json`
(mirrored in `.keys/instar-program.json`, both gitignored). The IDL and its TS
types are copied to `services/chain/idl/` on every build; `address` in the IDL
is the program id the world process uses unless `INSTAR_PROGRAM_ID` overrides it.
The site pins the same id in `site/chain.js` (`PROGRAM_ID`): wallet mode
refuses any other program, IDL address or world PDA the server names, and
`scripts/preflight.mts` fails when the pin and the IDL disagree, so a rotation
means editing that constant too.

## Design rule

Every balance the program holds has a withdrawal path that exists from
deployment and does not depend on any off-chain process being alive. If the
operator key were destroyed this instant and nobody ever ran the world again,
each lamport can still be got out, by someone, without anyone's permission:

| balance          | exit                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| creature vault   | `reclaim_vault` by its keeper once the world is winding down         |
| credit           | `withdraw` by its owner, at any time                                 |
| metabolism, pool | `withdraw_treasury` by the operator; `sweep_to_recovery` by anyone in wind-down |
| anything left    | `escheat` to `recovery`, 180 days after wind-down began              |

Wind-down is declared by the operator, or by anyone once the operator has been
silent for 90 days. Every operator instruction refreshes the heartbeat, so a
world that is being run never opens these doors.

## Money

All lamports live on the `World` PDA itself. Lamports come in through a CPI
`system_program::transfer` from the payer (`buy`, `buy_listed`, `fund`) and go
out by debiting the World account and crediting any writable recipient
(`withdraw`, `withdraw_treasury`, `sweep_to_recovery`, `escheat`), so a payout
can never be refused.

Solvency invariant, asserted at the end of every instruction that moves
lamports or ledger balances:

    world.lamports - rent_exempt(World) >= metabolism + pool + total_vaults + total_credit

`total_vaults` and `total_credit` are running totals kept on `World` because a
transaction cannot read every creature; each instruction that changes a vault
or a credit moves the same amount through the total. `scripts/check-recovery.mts`
prints both sides of the inequality; the test suite additionally checks the
totals against the sum of every creature and credit account after each flow.

## Accounts

`World`, seeds `["world"]`, one per program:

| field                 | type     |                                                             |
| --------------------- | -------- | ----------------------------------------------------------- |
| operator              | Pubkey   | the crank: registers births, settles deaths, posts epochs   |
| pending_operator      | Pubkey   | two-step hand-over                                          |
| recovery              | Pubkey   | where an abandoned world's money goes; set at init          |
| collection            | Pubkey   | the Core collection every larva's asset belongs to; set at init |
| next_id               | u64      | the next larva id the engine may register                   |
| total_alive           | u64      | larvae not DEAD                                             |
| last_epoch, last_epoch_tick, last_state_hash | u64, u64, [u8;32] | the last epoch commitment  |
| metabolism            | u64      | treasury that sets carrying capacity                        |
| pool                  | u64      | treasury that pays living larvae each epoch                 |
| total_vaults          | u64      | sum of every creature vault                                 |
| total_credit          | u64      | sum of every credit                                         |
| last_operator_action  | i64      | unix time of the last operator instruction                  |
| wind_down, wind_down_at | bool, i64 | one-way                                                  |
| bump                  | u8       |                                                             |

`Creature`, seeds `["creature", id as u64 LE]`, never closed:

| field             | type     |                                                        |
| ----------------- | -------- | ------------------------------------------------------ |
| id                | u64      |                                                        |
| parent_id         | u64      | `u64::MAX` for a founder                               |
| generation        | u32      |                                                        |
| birth_tick, death_tick | u64 |                                                        |
| genome_hash       | [u8;32]  | the engine's genome digest at birth                    |
| asset             | Pubkey   | the larva's Core asset; kept after the burn as record  |
| listed_by         | Pubkey   | who listed the larva for resale; default when not listed |
| listed_at         | i64      | when; a listing expires LISTING_MAX_AGE later          |
| vault             | u64      | lamports the larva holds, backed by World              |
| sale_price        | u64      | OFFERED: primary price; OWNED: resale price, 0 = not listed |
| status            | u8       | 1 OFFERED, 2 OWNED, 3 WILD, 4 DEAD (0 never on chain)  |
| pending_cull, cull_requested_at | bool, i64 |                                         |
| bump              | u8       |                                                        |

`last_state_hash` and `genome_hash` are zero-padded 64-bit digests, not
32-byte hashes: bytes 0..23 are zero and bytes 24..31 hold the engine's u64
(`state_hash()` at the epoch tick, `creature_genome_hash(slot)` at birth) in
big-endian order. The journal, the site and `/api/journal` carry only the
16-hex-character u64 form, so a third party checking the chain against a
replayed engine compares the last 8 bytes of the account field to that value.

`Credit`, seeds `["credit", owner]`: `owner`, `amount`, `bump`. Created with
`init_if_needed` by whichever instruction first owes the owner something; the
transaction's signer pays its rent. Never closed.

## The larva as an NFT

Who keeps a larva is not a field of `Creature`: it is the `owner` of the
larva's Metaplex Core asset (program `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`,
crate `mpl-core` 0.11 with the `anchor` feature). Wallets and marketplaces
index Core collections on their own, so a larva shows up where its keeper's
other NFTs do, and a keeper hands a larva on with a plain Core transfer; the
program has no `transfer` instruction.

`init_world` creates the collection (`CreateCollectionV2`, name `Instar`,
`collection_uri`) with the World PDA as update authority; the collection
account is a fresh keypair the client signs for and `World.collection`
records it. `register_birth` creates the asset (`CreateV2`, name
`Instar #<id>`, `uri`, again a fresh client-signed keypair recorded in
`Creature.asset`), owned by the World PDA, in the collection, with four
plugins whose authority is the World PDA, the three permanent ones being
addable only at creation:

| plugin | what the program does with it |
| --- | --- |
| `PermanentTransferDelegate` | `buy_listed` moves the asset from the seller to the buyer |
| `PermanentFreezeDelegate` | `request_cull` freezes the asset; a frozen asset cannot be transferred, so a larva awaiting its cull cannot leave the dish |
| `PermanentBurnDelegate` | `settle_death`, `force_settle_cull` and `reclaim_vault` burn the asset; the burn goes through a freeze |
| `Attributes` | `generation`, `parent` (id, or `founder`), `birth_tick`, `genome` (the 16-hex-character digest) for wallets to show |

`buy` moves the asset from the World PDA (signing as owner) to the buyer.
Every instruction that takes the asset checks `asset == creature.asset` and
that Core owns the account (`AssetMismatch`), and the collection against
`World.collection` (`WrongCollection`). Ownership checks read the asset's
`owner` at execution time: `list`, `request_cull` and `reclaim_vault` require
the signer to be that owner (`NotOwner`); `unlist` accepts the owner or
`listed_by`; the keeper paid by `settle_death` and `force_settle_cull` is the
owner at settlement, and their `keeper_credit` PDA is checked against it
(a WILD or OFFERED larva is owned by the World PDA and has no keeper).

The keeper share is a pull payment keyed by that owner: it lands in the
Credit PDA of whatever account holds the asset when the death is settled, and
`withdraw` needs that account's signature. An asset sitting in a
marketplace escrow, or sent to any address that cannot sign, forfeits its
keeper share to a credit nobody can draw (until escheat). Keep a larva in a
wallet you sign with; list it through `list`, from that wallet, rather than
on an external marketplace, if you want its death share.

A listing is only good while the asset is still in the lister's hands, and
for LISTING_MAX_AGE after it was made. `list` records `listed_by` and
`listed_at`; `buy_listed` requires `asset.owner == listed_by` and
`now - listed_at <= LISTING_MAX_AGE`, and pays `listed_by`'s credit, so a
larva moved with a native transfer since it was listed is `NotForSale`
until the new owner lists it themselves (or clears the stale listing with
`unlist`), and a listing that outlives the timer is `NotForSale` until it is
made again. The program cannot see a native transfer, so without the timer
a listing voided by the asset leaving `listed_by`'s hands would come back
to life the moment the asset returned there, at a price consented to for a
larva that has since kept earning.

Core does not delete a burned asset: it leaves a one-byte `Uninitialized`
stub behind, still owned by Core, and refunds the rest of the rent to the
payer. `Creature.asset` keeps pointing at it as the record of which asset
the larva was; the rent of a birth goes back to whoever settles the death.

A keeper can burn an unfrozen asset from their wallet, as they can any Core
asset they own; the record does not see it. The larva stays alive on chain
until the engine kills it, but nobody owns the stub: `list`, `request_cull`
and `reclaim_vault` load it as `WrongStatus`. `settle_death` alone accepts
the stub (its `asset` is an unchecked account pinned to `creature.asset`
and Core's ownership, read by hand): a burned asset means no keeper, the
keeper share goes to metabolism as for a larva the World held, `keeper_credit`
must be absent, and there is nothing to burn. `force_settle_cull` and
`reclaim_vault` keep the strict load: a larva awaiting its cull is frozen
and Core refuses its owner's burn, so no cull ever meets a stub; and a
reclaim needs the owner's signature, which a burned asset has nobody to
give. The vault of a larva whose keeper burned it is settled by the operator
like any death, and in an abandoned world it waits for escheat.

A keeper can also send the asset back to the World PDA with a plain
transfer. The larva is then OWNED with the dish as owner, nothing a keeper
can sign for; `open_offer` accepts it (OWNED and `asset.owner == World PDA`,
the listing cleared) so the operator can put it up for sale again as if
newborn. The service never does this on its own: it is operator tooling.

Local validators preload Core from `program/deps/mpl_core.so`; see
`program/deps/README.md` for the dump's provenance.

## Instructions

Operator instructions require `world.operator` as signer and set
`last_operator_action`. `id` arguments name the creature PDA. "keeper" below
is the asset's current owner; instructions that touch the asset also take
`asset`, `collection` and `mpl_core_program`.

| instruction | signer | effect |
| --- | --- | --- |
| `init_world(recovery, collection_uri)` | the program's upgrade authority (pays rent, becomes operator) | creates World and the Core collection (`collection` is a fresh keypair signer); the signer must be the upgrade authority named by the program-data account (`program`, `program_data` accounts), so nobody can claim the singleton PDA ahead of the deployer; `recovery` must be set and must not be the operator |
| `set_recovery(new)` | operator | not in wind-down; never the operator |
| `transfer_operator(new)` / `accept_operator()` | operator / pending | two-step |
| `heartbeat()` | operator | refreshes `last_operator_action` |
| `post_epoch(epoch, tick, hash)` | operator | `epoch == last_epoch + 1`, `tick > last_epoch_tick` |
| `register_birth(id, parent_id, generation, birth_tick, genome_hash, uri)` | operator (pays rent) | `id == next_id`; WILD; creates the Core asset (`asset` is a fresh keypair signer) owned by the World PDA; not in wind-down |
| `open_offer(id, price)` | operator | WILD, or OWNED with the asset back in the World PDA's hands (a keeper sent it to the dish natively), to OFFERED; clears any listing; not in wind-down |
| `buy(id, price)` | buyer | OFFERED and the asset still the World PDA's; `price` must equal `sale_price`; the `parent` account is required whenever `parent_id` is set; 60% vault, 15% metabolism, 15% pool, 10% to the parent's vault if the parent is OWNED, else pool; the asset moves to the buyer, OWNED; not in wind-down |
| `list(id, price)` | keeper | OWNED and no pending cull; price > 0; records `listed_by` and `listed_at` |
| `unlist(id)` | keeper or `listed_by` | clears the listing |
| `buy_listed(id, price)` | buyer | `sale_price > 0`, the asset still `listed_by`'s and the listing younger than LISTING_MAX_AGE, else NotForSale; 90% to `listed_by`'s credit (`seller_credit`, derived from the record), 5% metabolism, 5% pool; the vault travels with the larva; the asset moves to the buyer through the transfer delegate; refused for a pending cull and in wind-down |
| `reward_many(amounts)` | operator | creatures in `remaining_accounts`, one per amount; pool to vaults; DEAD skipped; not in wind-down |
| `settle_death(id, cause, tick, heir_count)` | operator | first `heir_count` of `remaining_accounts` are heirs (must be alive). Cause 6 with `pending_cull`: 85% keeper credit, 15% metabolism. Otherwise 40% heirs in equal shares (dust to pool; no heirs: to metabolism), 35% metabolism, 15% pool, 10% keeper credit (no keeper: metabolism). `keeper_credit` is an optional account, required when the larva has a keeper; burns the asset. An asset the keeper already burned natively is accepted: no keeper, `keeper_credit` absent, nothing burned. A larva already DEAD fails WrongStatus |
| `request_cull(id)` | keeper | OWNED; clears the listing, freezes the asset, starts CULL_TIMEOUT |
| `force_settle_cull(id)` | anyone | after CULL_TIMEOUT: 85% keeper credit, 15% metabolism; burns the asset |
| `withdraw()` | credit owner | credit to owner's account |
| `withdraw_treasury(m, p)` | operator | to any account; `u64::MAX` takes the whole pot, 0 takes none of it |
| `fund(amount, pool_bps)` | anyone | `pool_bps` to pool, the rest to metabolism; not in wind-down |
| `begin_wind_down()` | operator, or anyone after ABANDONED_AFTER | one-way |
| `reclaim_vault(id)` | keeper | wind-down: vault to credit, asset burned, larva DEAD |
| `sweep_to_recovery()` | anyone | wind-down: metabolism + pool to `recovery` |
| `escheat()` | anyone | wind-down + ESCHEAT_AFTER: everything above rent to `recovery`; ledger zeroed, later claims fail Insolvent |

Splits are integer basis points; the last share of each split takes the
rounding remainder so the parts always sum to the whole.

Once `wind_down` is set nothing new enters the world: births, offers, sales,
rewards and funding are refused with `WindingDown`. The ledger is being
emptied, and fresh lamports would only back stale claims.

Errors: `NotOperator`, `NotOwner`, `WrongStatus`, `WrongId`, `NotForSale`,
`WrongPrice`, `Insolvent`, `NotWindingDown`, `NotAbandoned`, `TooEarly`,
`EpochNotMonotonic`, `NothingToWithdraw`, `WindingDown`, `RecoveryIsOperator`,
`AssetMismatch`, `WrongCollection`.

## Timers

| constant         | deployed | `short-timers` feature |
| ---------------- | -------- | ---------------------- |
| ABANDONED_AFTER  | 90 days  | 4 s                    |
| ESCHEAT_AFTER    | 180 days | 4 s                    |
| CULL_TIMEOUT     | 7 days   | 3 s                    |
| LISTING_MAX_AGE  | 30 days  | 6 s                    |

`Clock::unix_timestamp` is the clock. A local validator cannot warp time, so
the test suite is run against a build with `--features short-timers` and waits
the timers out. `scripts/wsl-build-program.sh` records the feature set of the
artifact on disk in `program/target/deploy/instar.features`: `building:<set>`
from before `cargo build-sbf` runs until the build has fully succeeded, then
`<set>`, so a build that fails halfway never leaves a finished-looking marker
beside an artifact it cannot vouch for. The script always finishes with a
real-timer build. `scripts/deploy-program.mts` refuses any marker but
`default`, and an `instar.so` newer than the marker (a cargo run the script
did not make).

## Build and test

    npm run program:build      # artifact + IDL only (wsl-build-program.sh build)
    npm run program:test       # short-timers build + suite + restore (wsl-build-program.sh test)
    wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/tech/connectomes/scripts/wsl-build-program.sh retest   # suite only, against the short-timers artifact on disk

The Rust and Solana toolchains live in WSL (`anchor-cli 0.31.0`, Agave
`solana-cli 4.2.1`, platform-tools 1.54). The artifact is built with
`cargo build-sbf --arch v3` and the IDL with `anchor idl build`, not with
`anchor build`: build-sbf's default is sBPF v0, which a validator with every
feature enabled (the local test validator, and every cluster once SIMD-0500
activates) refuses to deploy, and `anchor build` cannot pass `--arch` without
also breaking its IDL step. sBPF v3 deployment is active on mainnet-beta and
devnet (SIMD-0178). `anchor test` starts its validator on rpc port 8999
(gossip 9199, faucet 9990) so it can run beside the world process's localnet
on 8899.

The mocha suite (`program/tests/instar.ts`) needs Node >= 22.18: it is plain
ESM TypeScript loaded by Node's own type stripping, and `@solana/web3.js`
depends on an ESM-only `uuid`. WSL's node is 18, so `[scripts] test` in
`Anchor.toml` runs `scripts/program-test-host.sh`, which executes the suite on
Windows Node 24 through WSL interop, with `ANCHOR_PROVIDER_URL` and a
path-translated `ANCHOR_WALLET` passed via `WSLENV`. The workspace's
`node_modules` is installed once from Windows (`cd program && npm install`).
The provider wallet is `.keys/operator.json`, created by
`scripts/wsl-program-keys.sh` if absent; it is also the localnet operator.

The suite covers, in the order of one world's life: the collection at init,
a birth minting the asset to the World PDA with its attributes, primary sale
splits and the asset moving to the buyer, price protection, resale through
the transfer delegate and the travelling vault, an unlisted larva not for
sale, withdraw, the ancestry royalty (live, dead and wrong parent), batched
rewards that skip the dead, inheritance with dust and the burn, wild deaths
burned from the World PDA, culls (requested, with the freeze, and not), a
native Core transfer voiding the old listing and making the new owner the
keeper, a keeper's native burn settling with no keeper share, a listing
expiring after LISTING_MAX_AGE, a larva sent back to the dish re-offered and
bought again, epoch monotonicity, operator-only access, treasury withdrawal
and funding, operator hand-over, recovery address rules, a stranger failing
to wind down a running world, self-service culls after the timeout, the
heartbeat keeping a world alive, a keeper recovering (and burning) their
larva with the operator gone forever, treasuries reaching only the recovery
address, the world emptying to exactly the one vault nobody reclaimed, that
vault escheating after the timer, and every record staying readable.
Solvency is asserted after every flow. Assets are read with
`@metaplex-foundation/mpl-core` over umi; the native transfer and burn are
the SDK's `transferV1` and `burnV1`.

## Localnet, deploy, init, audit

    npm run localnet                 # or: ... wsl-localnet.sh [port]
        validator on 127.0.0.1:8899 with the program preloaded as an upgradeable
        program whose upgrade authority is the operator (init_world requires
        that), Metaplex Core preloaded from program/deps/mpl_core.so at its
        real address, operator funded. A port argument (e.g. 8999) gives a
        second validator with its own ledger and derived gossip/faucet ports,
        for verify.mts beside a live world.

    npx tsx scripts/init-world.mts
        init_world(recovery, collection_uri) with a fresh collection keypair;
        idempotent. Env: INSTAR_CLUSTER (localnet | devnet | mainnet-beta),
        INSTAR_RPC, INSTAR_PROGRAM_ID, INSTAR_OPERATOR_KEYPAIR (default
        .keys/operator.json; must be the upgrade authority), INSTAR_RECOVERY
        (required on devnet and mainnet-beta; must not be the operator;
        localnet writes a throwaway .keys/recovery.json), INSTAR_COLLECTION_URI
        (default ${PUBLIC_URL}/api/collection.json; refused on a public cluster
        if it points at localhost, since it is written into the collection)

    npx tsx scripts/check-recovery.mts
        operator, recovery, heartbeat age, wind-down and escheat state, balances,
        accounted vs lamports; exit 1 if insolvent

Deploying to a public cluster:

    INSTAR_CLUSTER=devnet INSTAR_RECOVERY=<pubkey> npx tsx scripts/deploy-program.mts
    INSTAR_CLUSTER=mainnet-beta INSTAR_RECOVERY=<pubkey> npx tsx scripts/deploy-program.mts

`deploy-program.mts` checks that the artifact on disk is the real-timer build
and that `.keys/instar-program.json` is the keypair for the id compiled into
the program (`scripts/wsl-program-keys.sh` refuses to mint a new identity
silently), requires `INSTAR_RECOVERY` off localnet so the recovery address is
decided before the program exists, runs `scripts/wsl-deploy-program.sh`
(`solana program deploy` with `INSTAR_DEPLOYER_KEYPAIR`, default
`.keys/operator.json`, as payer and upgrade authority; then `anchor idl init`
the first time, `anchor idl upgrade` after), and immediately runs
`init-world.mts` with the same key so the World exists in the same run as the
program. Keep `.keys/instar-program.json` and the deployer key backed up: the
first is the program's identity, the second its upgrade authority and the only
key that can create the World.
