# When the world ends

The procedure for recovering every lamport that is legitimately the
operator's once Instar is over, and what happens to everyone else's on the
way. One command drives it and can be run as many times as it takes:

```
npx tsx scripts/operator.mts recover-all --to <recovery address> [--yes] [--allow-fresh]
```

It reads the chain, prints the six steps below with what each one is
(done, possible now, or waiting on a date), sends the possible ones with
`--yes`, and prints the lamports that reached the recovery address per step
and in total. Without `--yes` it prints the same timeline and sends nothing.
`--to` must be the World's recovery address while the World exists (the
program pays that address and no other, so the whole procedure lands in one
place); after the World is closed it is where the remaining keys drain to.
The address is checked the way `set-recovery` checks one: on the curve,
system-owned, and it has signed a transaction, unless `--allow-fresh` says
you hold the key.

Every step is one-way. Nothing here can be undone, and the order matters
because each step destroys what the next one would have needed to run
differently.

## The timeline

| step | instruction | who may send it | when | what moves, and to whom |
|---|---|---|---|---|
| 1 | `begin_wind_down` | the operator; anyone after 90 days of operator silence | any time | nothing. Births, offers, sales, rewards and `fund` are refused from this slot; deaths and epochs still settle |
| 2 | `sweep_to_recovery` | anyone | wind-down | metabolism + pool, to recovery. Vaults and credits untouched |
| 3 | `escheat` | anyone | 180 days after wind-down began (day 270 at the earliest for a world abandoned at day 90) | everything the World holds above its rent, to recovery: every vault and credit nobody claimed. The ledger is zeroed |
| 4 | `close_record` × N, `close_credit` × M, `close_world` | anyone | after escheat | the rent of every Creature PDA, every Credit PDA, then the World PDA, to recovery |
| 5 | system transfers | the operator | after close_world | the fee keypair (after a last claim of the coin's creator fees) and the operator keypair, to recovery |
| 6 | `solana program close` | the upgrade authority | after close_world | the program's rent (its program-data account), to recovery |

`recover-all` covers 1 to 5 and prints the exact command for 6, which is
`scripts/wsl-close-program.sh`; that script refuses while the World PDA
still exists. After 6, run `recover-all` once more: the operator keeps a
rent floor plus two fees to sign the program close, and the last run takes
that to zero.

Between 3 and 4, if the world had custodial wallets:

```
npx tsx scripts/operator.mts sweep-custodial --to <recovery address> [--nfts] --yes
```

## What keepers get, and keep

The program's rule is that every balance has an exit that needs nobody's
permission, and wind-down opens all of them at once. From step 1 a keeper
can:

- **reclaim their fly's vault** with `reclaim_vault`, sent from the wallet
  that holds the asset (there is no site button yet; a custodial keeper
  withdraws the fly to a wallet first): the vault becomes their credit, the
  asset is burned, the fly is DEAD on the record;
- **withdraw their credit** with `withdraw`, at any time, as always;
- **keep their NFT.** A fly they do not reclaim stays theirs as a Core
  asset in their wallet. Nothing in this procedure touches an asset a
  keeper holds: `close_record` closes the program's record of the fly,
  not the asset, and a fly that was still OWNED when its record closed is
  an ordinary collectible afterwards, transferable like any Core asset, in
  the Instar collection, with its attributes. Its vault, if they never
  reclaimed it, went to recovery at step 3.

The 180 days between steps 1 and 3 are theirs. Tell them, and leave the
process running through it: a death settled during wind-down credits the
whole vault to its keeper (no heirs, no treasuries; to metabolism only when
the fly has no keeper), so a fly that dies before its keeper acts loses
nothing, and the site keeps working for withdrawals. What nobody has claimed
by the end of the clock goes to recovery at step 3, and from then on a late
`reclaim_vault` or `withdraw` fails `Insolvent`: the ledger says nothing is
owed.

**Custodial wallets** are the exception the program cannot see. An Instar
account is a keypair the world process holds for the keeper; the SOL and the
flies in it are the keeper's, reachable through the site while the process
runs, and the keys are in `accounts.json` (sealed under `INSTAR_MASTER_KEY`)
for as long as a backup exists. The same 180-day rule is applied to them by
hand: `sweep-custodial` refuses until the chain says `escheated` — the same
clock, checked on chain, not on a calendar — and then moves every custodial
wallet's SOL to the recovery address, the operator paying the fees so each
wallet ends at exactly zero. With `--nfts` it also moves the flies they
keep (Core `TransferV1` from the custodial wallet to recovery); without it
those flies stay in the custodial wallets, which keep existing as long as
the backup and the master key do. This is disclosed where the account is
created (the account window on the site) and in `docs/ECONOMY.md`: "If the
world is wound down and you have not withdrawn 180 days later, what is left
in your Instar account goes where the program's unclaimed funds go: the
recovery address."

`recover-all` refuses step 4 while `DATA_DIR/accounts.json` is present and
any custodial wallet still holds SOL (or a record in it cannot be opened
under the current master key), because `sweep-custodial` needs the World's
`escheated` flag and the World closes in step 4; and `--nfts` finds the
flies through the records, which step 4 closes too. If the file is not on
this machine it says so and continues: restore the backup here, or accept
that those wallets keep what they hold.

## What it returns

All figures are read from the chain at the time; these are the ones
measured on a localnet validator with the current artifact and rent
parameters (September 2026). Rent is whatever the RPC reports, not a
constant: the rent-exempt minimum of an empty account read 650,240 lamports
(0.00065024 SOL) on mainnet in 2026-09 (`docs/COIN.md`), below the localnet
parameters here, so mainnet sums come out smaller:

| account | rent | how many |
|---|---|---|
| Creature PDA | 0.00210888 SOL (2,108,880 lamports) | one per fly ever born (`next_id`) |
| Credit PDA | 0.00123192 SOL (1,231,920 lamports) | one per address ever paid a credit (seller, keeper, reclaimer) |
| World PDA | 0.0027492 SOL (2,749,200 lamports) | one |
| program-data account | 4.27002264 SOL (4,270,022,640 lamports) | one; sized by the deployed artifact (613,336 bytes here; `solana program show <id>` prints the deployed one's balance) |
| Core asset | not the program's | a fly's asset rent went back to whoever settled its death (burn); a living fly's asset stays with its keeper |

So for a world that saw N births and M credit accounts, steps 4 and 6
return about `0.0021 × N + 0.0012 × M + 0.0027 + 4.27` SOL on top of
whatever steps 2, 3 and 5 moved. `recover-all` prints the exact sums it
finds before sending (the records' rent is read from the accounts, not
computed).

The fee keypair: the world's ten-minute sweep leaves it holding its
rent-exempt minimum plus `INSTAR_GAS_RESERVE` (default 0.05 SOL). An account
cannot pay its own fee out of the rent floor (a fee payer must remain
rent-exempt after its fee is taken, or end at zero), so step 5 has the
operator pay the fee and drains the key to zero. With `INSTAR_COIN_MINT`
set, step 5 first claims whatever the coin's creator vaults still hold, into
the fee keypair, and drains that too.

## The order, and what each step destroys

1. **`begin_wind_down`** ends the market for good. There is no way back to
   a running world on this program id: `wind_down` is never cleared.
   Announce it first; the site's copy is yours to change.
2. **`sweep_to_recovery`** can be sent any number of times; it moves what is
   in the treasuries at the moment. It makes step 3 no larger.
3. **`escheat`** is the one step that takes other people's money: every
   vault and credit not claimed in 180 days. It is idempotent on chain (a
   second call moves nothing) and sets `escheated`, which is what unlocks
   step 4 and `sweep-custodial`. After it, no claim against the program can
   succeed.
4. **`close_record`**, **`close_credit`**, **`close_world`** delete the
   accounts. Every record is readable on chain until its own close lands
   (batched twenty to a transaction, resumable: a run closes what it finds
   open, and `closed_records` / `credits_open` on the World count down).
   `close_world` needs both counters to say nothing is left
   (`RecordsStillOpen` otherwise). Take the last backup before this: the
   journal is then the only history of what those flies did, and the
   burned assets' one-byte stubs are all that is left of them on chain. The
   Core collection account is not closed: it is Core's, not the program's,
   and its update authority was the World PDA, which no longer exists, so
   it becomes an ownerless collection that still names every asset in it.
5. **Draining the keys** is ordinary transfers. The operator keeps its
   rent-exempt minimum plus two fees (rent as read from the RPC at the time;
   0.00065024 SOL on mainnet, 2026-09) if it is the program's upgrade
   authority, so that it can sign step 6 and the drain after.
6. **`solana program close`** returns the program's rent and makes the
   program id undeployable forever. `scripts/wsl-close-program.sh` refuses
   while the World PDA exists, because a closed program leaves every account
   it owns unreadable and unclosable, rent and all.

If the operator key is gone, steps 1 to 4 need no operator at all (anyone
may send them, and only the recovery address ever receives), step 5 has
nothing to drain, and step 6 is impossible: the program's rent stays where
it is. That is the cost of a lost key, and the reason the upgrade authority
belongs with the recovery keypair in cold storage.
