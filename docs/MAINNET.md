# Going live

Instar on Solana mainnet-beta, with `$INSTAR` launched separately and its
creator earnings fed into the cage.

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
| a fly's vault | its keeper, via `reclaim_vault` in wind-down | no |
| a fly's vault, cull ignored | anyone, via `force_settle_cull` after 7 days | no |
| your credit | you, via `withdraw`, always | no |
| metabolism + pool | `withdraw_treasury` while running; `sweep_to_recovery` after | no |
| anything nobody claims | `escheat` to recovery, 180 days after wind-down | no |
| the rent of every record, credit and the World | `close_record`, `close_credit`, `close_world` to recovery, after escheat | no |
| the program's own rent | `solana program close` to recovery, once the World is closed | the upgrade authority |

The mechanism is a heartbeat. Every operator instruction refreshes it. After 90
days of silence anyone may call `begin_wind_down`, which opens every exit at
once. A stranger calling it cannot benefit: `recovery` is fixed at
`init_world` and cannot change once the world is winding down.

**When it is over.** The end of the world is one documented procedure,
`docs/RECOVERY.md`, driven by `npx tsx scripts/operator.mts recover-all --to
<recovery>`: wind-down, sweep, escheat after the 180 days, then every
account closed for its rent, the keys drained, and the program closed for
its own rent, with what each step returns and to whom. Custodial wallets
follow the same 180-day rule (`sweep-custodial`), and the site says so
where the account is made.

## 1. Keys

```
npm run keys:new -- .keys/mainnet --program
```

writes `operator.json` (deployer, upgrade authority, world operator),
`recovery.json` (where an abandoned world's money goes), `fee.json` (the
`$INSTAR` creator-fee destination the world sweeps) and `master.key` (seals
custodial wallets at rest) under `.keys/mainnet/`, and with `--program`
rotates the program identity (`.keys/instar-program.json`, `declare_id!`,
`Anchor.toml`), after which `npm run program:test` rebuilds and re-proves the
program under the new id. It refuses to overwrite anything.

Back the directory up offline before any key holds a lamport. The master key
and the program keypair have no recovery path. The recovery keypair is the one
to keep coldest: it is the address every exit points at when everything else
is gone. Moving `recovery.json` to a hardware wallet and using that address
instead is better still; only its public key is needed at init.

## 2. Before spending anything

```
INSTAR_CLUSTER=mainnet-beta INSTAR_DEPLOYER_KEYPAIR=.keys/mainnet/operator.json \
INSTAR_RECOVERY=<recovery pubkey> INSTAR_MASTER_KEY=<master.key> \
INSTAR_FEE_KEYPAIR=.keys/mainnet/fee.json npm run preflight
```

Preflight checks the artifact (real timers), the program identity (keypair,
`declare_id!`, IDL and `Anchor.toml` agree), every key, the RPC's genesis
hash, the operator balance against the deploy rent, whether the program and
world already exist and who owns them, the engine, the site files and the
role maps. It sends nothing. Every line must read `ok` or `next`.

- [ ] `npm run sim:build` passes its gates on the engine you are about to ship
- [ ] `npm run program:test`: 40 passing, including both recovery drills and the closing of every account
- [ ] `npm run verify` against a scratch validator, `npm run journey` against a local world
- [ ] a devnet rehearsal (below) has run for at least a day with `npm run verify:epoch` reporting VERIFIED
- [ ] the host has at least 2 GB of RAM: the engine holds ~0.6 GB of WebAssembly memory at 40 flies and the snapshot copies it once more while compressing
- [ ] `.keys/mainnet/` and `.keys/instar-program.json` are backed up offline
- [ ] `npm run preflight` on mainnet-beta reports `ready`

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

Open http://localhost:8787, and from another terminal run
`INSTAR_URL=http://localhost:8787 npm run verify:epoch`: it replays the world
to the next epoch boundary on your machine and compares with the World
account it reads from `api.devnet.solana.com` itself (docs/OPERATIONS.md,
"Memory, the snapshot, and the verifier"). Leave it a day; a world that
survives its own restarts, a stale journal and a rate-limited RPC on devnet is
the world you deploy.

## 3. Sequence

### a. Deploy the program and create the world

```
INSTAR_CLUSTER=mainnet-beta INSTAR_DEPLOYER_KEYPAIR=.keys/mainnet/operator.json \
INSTAR_RECOVERY=<recovery pubkey> PUBLIC_URL=https://instarcage.com npm run program:deploy
```

One run: it deploys the real-timer artifact (the script refuses a short-timers
build, and refuses a program keypair that does not match the compiled id) with
the deployer key as upgrade authority, publishes the IDL on chain, and
immediately calls `init_world` with that same key. Only the upgrade authority
can create the World, so the deployer key is the operator; it may be handed to
another key later with `transfer_operator` + `accept_operator`. The program
refuses a recovery address equal to the operator.

`init_world` also mints the world's Metaplex Core Collection, with
`PUBLIC_URL/api/collection.json` as its metadata URI (override with
`INSTAR_COLLECTION_URI`). The URI is fixed at creation and `init-world.mts`
refuses a localhost one off localnet, so `PUBLIC_URL` must already be the
real origin here, the same value the world process is started with.

### b. Read it back

```
INSTAR_CLUSTER=mainnet-beta npm run check:recovery
```

It prints `recovery`, `operator`, the heartbeat age and the solvency
inequality. Confirm `recovery` is your cold wallet before sending anything.

### c. Start the world

Set on the host (Railway, or anything that runs `npm start`); `.env.mainnet.example`
is a template. Mount `.keys/mainnet/operator.json` and `fee.json` into the
volume (never bake them into the image):

| env | value |
|---|---|
| `INSTAR_CLUSTER` | `mainnet-beta` |
| `INSTAR_RPC` | a paid RPC endpoint; the public one rate-limits |
| `INSTAR_PUBLIC_RPC` | an RPC URL the site hands to browsers, for wallet mode and the in-page verifier: a provider key restricted to the `PUBLIC_URL` origin. Mainnet's public endpoint refuses browser origins with 403, so without this those two features cannot read the chain |
| `INSTAR_OPERATOR_KEYPAIR` | path to the operator keypair file mounted into the container. Hosts that only pass secrets as variables (Railway) set `INSTAR_OPERATOR_KEYPAIR_JSON` to the 64-number array instead; the world writes it once to `DATA_DIR/keys/operator.json` (mode 0600) and reads the file from then on |
| `INSTAR_MASTER_KEY` | 32 random bytes as hex; encrypts custodial wallets at rest. REQUIRED on mainnet-beta: the world refuses to start without it (on localnet/devnet it defaults to a key derived from the operator key, which would lock every keeper out if the operator key were rotated or lost). Keep it separately from the operator key |
| `DATA_DIR` | a persistent volume (`/data`); journal, snapshot (`snapshot.bin.gz`, ~150 MB, rewritten every five minutes), accounts and sessions live here |
| `PUBLIC_URL` | the public origin: written into every fly's NFT as its metadata URI at birth, and into the collection at `init_world`. Fix it before the first birth and never change it; a moved host keeps serving under the same domain, or older NFTs point at a dead address |
| `INSTAR_GAS_RESERVE` | SOL the operator keeps for fees before it pauses settlement (default 0.05) |
| `INSTAR_TRUST_PROXY` | `1` behind a reverse proxy that overwrites `X-Forwarded-For` (Railway): the sign-in rate limit is keyed by client IP, and without it every visitor shares the proxy's address |
| `INSTAR_ADMIN_TOKEN` | a long random string; enables `GET /api/backup` and the verifier's `--post`, accepted only as an `Authorization: Bearer` header |
| `GOOGLE_CLIENT_ID` | optional; enables Google sign-in |
| `INSTAR_FRESH` | `1` once, on the very first boot against this program; remove afterwards |

A mainnet world is a fresh genesis: new program, new journal. The boot check
refuses to start if the world and the program disagree about how many flies
exist, so a stale journal cannot quietly corrupt it.

### d. Launch the token, then feed the cage

Launch `$INSTAR` on pump.fun with its **creator** set to the `fee.json`
address from `npm run keys:new`; that field is written once, at launch, and
decides where every creator fee goes for the life of the coin. The launch
wallet can be any hot wallet; the fee keypair does not sign. Holder rewards,
cashback and Mayhem mode off. `docs/COIN.md` has the whole procedure and
what the coin is. Then:

| env | value |
|---|---|
| `INSTAR_FEE_KEYPAIR` | path to `fee.json` inside the container, or `INSTAR_FEE_KEYPAIR_JSON` with its contents |
| `INSTAR_COIN_MINT` | the coin's mint address |

Seed the fee keypair once, from the operator key: `npx tsx
scripts/operator.mts fund-fee-keypair 50000000 --yes` (0.05 SOL). It pays
every claim and nothing else ever pays it. Re-run preflight with both set:
it confirms the bonding curve's creator is the fee keypair, fails if it is
not, and fails while the fee keypair holds under 0.02 SOL. Every ten minutes the process claims
the coin's creator-fee vaults (bonding curve and, after graduation, the
canonical PumpSwap pool) into the fee keypair and sweeps it into
`fund(5000)`. `npx tsx scripts/fees.mts status` shows the vaults and the last
claim. `fund` is permissionless: anyone can feed the cage from any wallet at
any time, and the income does not stop when the process does.

## 4. What can go wrong, worst first

**The operator key is lost.** Covered: 90 days, then anyone opens the exits.
Before that, `transfer_operator` + `accept_operator` moves the role to a new key
while the old one still signs.

**The master key is lost.** Custodial wallets are AES-256-GCM sealed under it.
Without it their keys are unreadable and the SOL in them is gone. Back it up
with the same care as the operator key; the process quarantines records it
cannot open rather than overwriting them.

**The process dies.** The cage stops advancing but nothing is lost: every exit
is permissionless or keeper-driven, and the journal plus snapshot resume it.

**The RPC rate-limits.** Settlement pauses with the ops queued and resumes;
births are never dropped, only delayed. Use a paid endpoint.

**A cluster restart or a dropped transaction.** Every operator op re-reads the
chain before resending, so a birth, offer, death or epoch is never registered
twice.

**The volume is lost.** The journal is the world's memory; without it the
process refuses to continue against a program that already holds flies. Set
`INSTAR_ADMIN_TOKEN` and pull a backup hourly from a machine that is not the
host: `INSTAR_ADMIN_TOKEN=… npx tsx scripts/backup.mts --pull https://your.domain`
(the script sends the token as a Bearer header; the route takes no `?token=`).
That, and the rest of the world's life, is in `docs/OPERATIONS.md`.
