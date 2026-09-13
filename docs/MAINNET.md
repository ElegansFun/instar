# Going live

Instar on Solana mainnet-beta, with `$INSTAR` launched separately and its
creator earnings fed into the dish.

## 0. The rule this document exists to enforce

A world that holds other people's money has exactly one unforgivable failure
mode: a balance nobody can reach. Not a hack; an exit that ran through a key,
or a process, that stopped existing.

So: **nothing is deployed until the address that can recover it exists.**
`INSTAR_RECOVERY` is required by the mainnet deploy and init scripts, and they
refuse to run without it. It should be a wallet you will still control in five
years, not the operator key that runs the world.

What that buys, in the deployed program, from the first slot:

| balance | who can get it out | needs the operator? |
|---|---|---|
| a larva's vault | its keeper, via `reclaim_vault` in wind-down | no |
| a larva's vault, cull ignored | anyone, via `force_settle_cull` after 7 days | no |
| your credit | you, via `withdraw`, always | no |
| metabolism + pool | `withdraw_treasury` while running; `sweep_to_recovery` after | no |
| anything nobody claims | `escheat` to recovery, 180 days after wind-down | no |

The mechanism is a heartbeat. Every operator instruction refreshes it. After 90
days of silence anyone may call `begin_wind_down`, which opens every exit at
once. A stranger calling it cannot benefit: `recovery` is fixed at
`init_world` and cannot change once the world is winding down.

## 1. Before spending anything

- [ ] `npm run sim:build` passes its gates on the engine you are about to ship
- [ ] `npm run program:test`: 31 passing, including both recovery drills
- [ ] `npm run verify` against a scratch validator, `npm run journey` against a local world
- [ ] a devnet rehearsal (below) has run for at least a day with epochs verifying from a browser
- [ ] `.keys/instar-program.json` (the program's identity) and the deployer key are backed up offline
- [ ] `INSTAR_RECOVERY` is a wallet you control and is **not** the operator key
- [ ] the deployer wallet holds enough SOL for the program account (about 3 SOL for the 427 KB artifact at current rent) plus fees

### Devnet rehearsal

The same sequence as mainnet, against devnet, with faucet SOL:

```
npm run devnet:fund -- 4              # public faucet; rate-limited per address and IP
```

When the public faucet refuses (it often does), fund the operator address it
prints from https://faucet.solana.com, which needs a GitHub login. Then:

```
INSTAR_CLUSTER=devnet INSTAR_RECOVERY=<any wallet you control> npm run program:deploy
INSTAR_CLUSTER=devnet npm run world
INSTAR_URL=http://localhost:8787 npm run journey     # the airdrop route asks devnet's faucet
```

Open http://localhost:8787 and watch epochs turn VERIFIED: the page reads the
World account from `api.devnet.solana.com` itself. Leave it a day; a world that
survives its own restarts, a stale journal and a rate-limited RPC on devnet is
the world you deploy.

## 2. Sequence

### a. Deploy the program and create the world

```
INSTAR_CLUSTER=mainnet-beta INSTAR_RECOVERY=<cold wallet> npm run program:deploy
```

One run: it deploys the real-timer artifact (the script refuses a short-timers
build, and refuses a program keypair that does not match the compiled id) with
the deployer key as upgrade authority, publishes the IDL on chain, and
immediately calls `init_world` with that same key. Only the upgrade authority
can create the World, so the deployer key is the operator; it may be handed to
another key later with `transfer_operator` + `accept_operator`. The program
refuses a recovery address equal to the operator.

### b. Read it back

```
INSTAR_CLUSTER=mainnet-beta npm run check:recovery
```

It prints `recovery`, `operator`, the heartbeat age and the solvency
inequality. Confirm `recovery` is your cold wallet before sending anything.

### c. Start the world

Set on the host (Railway, or anything that runs `npm start`):

| env | value |
|---|---|
| `INSTAR_CLUSTER` | `mainnet-beta` |
| `INSTAR_RPC` | a paid RPC endpoint; the public one rate-limits |
| `INSTAR_OPERATOR_KEYPAIR` | path to the operator keypair file mounted into the container |
| `INSTAR_MASTER_KEY` | 32 random bytes as hex; encrypts custodial wallets at rest. REQUIRED on mainnet-beta: the world refuses to start without it (on localnet/devnet it defaults to a key derived from the operator key, which would lock every keeper out if the operator key were rotated or lost). Keep it separately from the operator key |
| `DATA_DIR` | a persistent volume (`/data`); journal, snapshot, accounts and sessions live here |
| `PUBLIC_URL` | the public origin, used in larva metadata |
| `INSTAR_GAS_RESERVE` | SOL the operator keeps for fees before it pauses settlement (default 0.05) |
| `GOOGLE_CLIENT_ID` | optional; enables Google sign-in |
| `INSTAR_FRESH` | `1` once, on the very first boot against this program; remove afterwards |

A mainnet world is a fresh genesis: new program, new journal. The boot check
refuses to start if the world and the program disagree about how many larvae
exist, so a stale journal cannot quietly corrupt it.

### d. Launch the token, then feed the dish

Launch `$INSTAR` from a wallet you control, with its creator-fee destination
set to a keypair you can hand to the world process. Then:

| env | value |
|---|---|
| `INSTAR_FEE_KEYPAIR` | path to that keypair |

The process sweeps it every ten minutes into `fund(5000)`. `fund` is
permissionless: anyone can feed the dish from any wallet at any time, and the
income does not stop when the process does.

## 3. What can go wrong, worst first

**The operator key is lost.** Covered: 90 days, then anyone opens the exits.
Before that, `transfer_operator` + `accept_operator` moves the role to a new key
while the old one still signs.

**The master key is lost.** Custodial wallets are AES-256-GCM sealed under it.
Without it their keys are unreadable and the SOL in them is gone. Back it up
with the same care as the operator key; the process quarantines records it
cannot open rather than overwriting them.

**The process dies.** The dish stops advancing but nothing is lost: every exit
is permissionless or keeper-driven, and the journal plus snapshot resume it.

**The RPC rate-limits.** Settlement pauses with the ops queued and resumes;
births are never dropped, only delayed. Use a paid endpoint.

**A cluster restart or a dropped transaction.** Every operator op re-reads the
chain before resending, so a birth, offer, death or epoch is never registered
twice.

**The volume is lost.** The journal is the world's memory; without it the
process refuses to continue against a program that already holds larvae. Back
up `DATA_DIR` on a schedule.
