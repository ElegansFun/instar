# Running the world

Day two onward: what to watch, what to back up, and what to do with your
hands when something needs them. `docs/MAINNET.md` is the launch; this is the
rest of the world's life.

Two tools carry every procedure below:

```
npx tsx scripts/operator.mts <command> [args] [--yes] [--allow-fresh]     # every instruction the process does not send itself
npx tsx scripts/backup.mts [--pull <url> | --list f | --restore f [--force]]   # the record, out and back in
```

`operator.mts` reads `INSTAR_CLUSTER`, `INSTAR_RPC` and `INSTAR_OPERATOR_KEYPAIR`
the way the world process does, and before sending anything checks that the
endpoint's genesis hash is the cluster's (a mainnet URL under
`INSTAR_CLUSTER=devnet` stops there). `backup.mts` never touches the chain: it
reads `DATA_DIR`, `PORT`, `INSTAR_BACKUP_DIR` and, for `--pull`,
`INSTAR_ADMIN_TOKEN`. Both reject a `--flag` they do not know rather than
dropping it. `operator.mts` prints exactly what it is about to send and sends
nothing without `--yes`; after a transaction it re-reads the World and prints
every field that changed, so the diff is the receipt. A command it knows the
program will refuse (a stranger winding down a live world, a recovery address
equal to the operator, re-offering a larva a keeper still holds) stops before
sending. `withdraw-treasury` and `set-recovery` also refuse a destination
that is not on the curve, is owned by a program, or has never signed a
transaction — a mistyped address is usually still a valid one — unless
`--allow-fresh` says you hold that key.

## Monitoring

`GET /api/health` is the process's own account of itself, and Railway's
healthcheck (`railway.json`). While the world is being built it answers
**503** `{ok: false, phase: "replaying", tick, target}` (every other route
503 too); the port is bound before the journal is read, so a replay from
genesis is visible as `tick` climbing towards `target` rather than as a
refused connection. Live, it answers 200 with:

| field | meaning | act when |
|---|---|---|
| `ok` | `rpc.ok` and the queue is not stuck — nothing else; a failed journal write or a paused queue leaves `ok: true` | false |
| `phase` | `live` | — |
| `tick`, `ticksBehindWallClock` | the engine paces 20 ticks a second from the moment this process went live; a positive drift means the host cannot keep up | drift keeps growing |
| `lastEpochPostedAgoS` | seconds since the last `post_epoch` landed, read from the persisted transaction log, so right after a restart it is the pre-restart age; `null` when no successful epoch is among the last 400 records | above 600 while `pendingOps` > 0 |
| `pendingOps`, `stuckForS` | operator transactions waiting, and how long the head of that queue has not moved | `stuckForS` > 900: that is what turns `ok` false |
| `settling` | false when the operator balance is below the gas reserve + one settlement; the queue holds, the world keeps running | false: top the operator up (below) |
| `operatorSol` | live balance when the RPC answers, otherwise the last one the queue saw | under 0.2 SOL |
| `journalOk` | the last journal write succeeded | false: the disk is full or the volume is gone; nothing on chain is lost, but stop and fix the volume before the next restart |
| `rpc.ok`, `rpc.slot` | the RPC answered `getSlot` inside 5 s; the probe is shared by every request inside 10 s, so hammering the route costs the endpoint nothing | false: turns `ok` false |

It answers **503** when `rpc.ok` is false or the queue has held one op for more
than 15 minutes. Both are conditions a restart does not fix, so a supervisor
that restarts on 503 should do so with a bounded retry (Railway's
`ON_FAILURE`, 10 retries): the restart is harmless (the journal resumes the
queue), and the alert is what matters. At deploy time a 503 blocks the
rollout: `healthcheckTimeout` is 600 s, which covers a replay from genesis of
a long-lived journal; a deploy made while the RPC is down fails, and that is
the right answer.

`npx tsx scripts/operator.mts status` prints the World account, the operator
and recovery balances, the heartbeat age against the 90-day abandonment
clock, and the `/api/health` of the process at `INSTAR_URL` (default
`http://localhost:8787`). `npm run check:recovery` prints the solvency
inequality; it must always hold, and the program asserts it on every
instruction that moves money, so a `NO` there means a program bug, not an
operations problem.

In the logs, every line is prefixed `[instar]`. The ones that need a person:

| line | what happened |
|---|---|
| `settlements paused — operator holds …` | out of gas; fund the operator |
| `RPC rate limited — backing off for 60s` | the endpoint is throttling; if it repeats, move to a paid one |
| `birth N has NOT landed (…) — holding the queue` | a birth the chain refused for a reason other than identity; the queue waits; read the error |
| `death of #N refused with WrongStatus while the record is still alive` | the record and the world disagree about a living larva; the queue holds; needs a look at that creature on chain |
| `JOURNAL WRITE FAILED` | the volume; see `journalOk` |
| `THE WORLD IS WINDING DOWN` | the program refused new life: someone called `begin_wind_down` (you, or anyone after 90 days of silence) |
| `REFUSING TO START` | identity mismatch between the journal and the program; see Restore |
| `N account(s) could not be decrypted by this world` | the process started under a different master key; see Key rotation |

## Backups

```
INSTAR_ADMIN_TOKEN=<the world's> npx tsx scripts/backup.mts --pull https://your.domain   # from anywhere -> backups/instar-<cluster>-<iso>.tgz
npx tsx scripts/backup.mts                                                               # from the files in DATA_DIR, on the host
npx tsx scripts/backup.mts --list <file>
```

The archive is a gzipped ustar tar (`tar tzf` opens it) of `DATA_DIR`:
`journal.json` (the replayable record and the op queue) and its `.bak`,
`snapshot.bin`, `accounts.json` and its `.bak`, `sessions.json`,
`genesis.lock` and the quarantine file. Two ways to take one:

- **`--pull`** asks the running world for it: `GET /api/backup` builds the
  same archive from the live objects (snapshot first, journal right after, in
  one turn of the event loop, so the pair always resumes rather than
  replays) and streams it. The route exists only when the process has
  `INSTAR_ADMIN_TOKEN` set, takes the token as `?token=` or a bearer header
  (`--pull` sends the header), and answers 403 to anything else. This is the
  mainnet backup: run it **from outside the host** — a cron on another
  machine, hourly — because on Railway the container disk is gone at every
  deploy and the volume is the thing being backed up.
- **no arguments** copies the files on the host. Every file is written by
  the process with tmp + fsync + rename, so a copy never sees a torn file,
  and the snapshot is copied before the journal. Inside the container the
  default `backups/` is `/app/backups`, which does not survive a deploy, so
  the script refuses that default when `DATA_DIR` is absolute; set
  `INSTAR_BACKUP_DIR` to somewhere that is not the volume you are backing
  up, or use `--pull`.

Either way the script reads the archive back and compares every member
before it gets its final name, and fsyncs it first, so a power loss cannot
leave an empty file with a backup's name.

`accounts.json` is the only copy of every keeper's custodial key, sealed
under `INSTAR_MASTER_KEY`. The archive is exactly as secret as that key:
store the two apart, and treat a backup that has left the host as a copy of
every wallet in the world. A backup taken before a master-key rotation is
sealed under the old key; keep that key (offline) for as long as you keep
those archives, or take a fresh backup right after rotating and destroy the
old ones.

Schedule: hourly on mainnet, and keep a day of them. Nothing on chain
depends on a backup — every larva, vault and credit lives in the program —
but the journal is the world's memory: without it the process cannot prove
to itself which larvae it named, and refuses to continue against a program
that already holds them.

### Restore

```
# stop the world first
npx tsx scripts/backup.mts --restore backups/instar-mainnet-beta-<iso>.tgz
# start the world
```

`--restore` refuses while `DATA_DIR/world.lock` is held by a live process —
the world writes it before it reads a file and removes it on a clean exit,
so a world that is still replaying counts as running — and while anything
answers on `PORT`. It prints the archive's `cluster/programId/tick/epoch`
beside the current record's and refuses an archive from another cluster or
program, or one older than the record already in `DATA_DIR`, unless
`--force` is given: rolling the record back is the one thing to do only on
purpose.

Whatever is in `DATA_DIR` is moved to `DATA_DIR/pre-restore-<iso>/` first,
then the archive's files are written in (fsync + rename). `accounts.json`
is **merged**, not replaced: every keeper who signed up after the backup
has a custodial key that exists only in the current file, so the restored
file is the union of the archive's and the current one, the current record
winning for the same user (both are sealed under the same master key). The
same for `accounts.json.unreadable.json`. The script prints how many came
from each. The `pre-restore-` directory may be deleted once the world has
come up and posted an epoch — its `accounts.json` has already been merged.

What the world does with an older journal, at boot, in order:

1. Births in the restored queue that had already landed on chain are retired
   from the queue (their genome hash on chain is checked against the queue
   first).
2. Ids the program holds that the restored journal never named, up to 32 of
   them, are re-queued as reconstructed births.
3. More than that, or any id whose genome does not match, is
   `REFUSING TO START`. That is the right answer: a journal that far behind
   would put strangers' larvae in the record. Use a newer backup.

## The operator balance

The operator pays for every birth (Creature rent + Core asset rent, about
0.003 SOL, plus fees), death, reward batch and epoch post. When it holds less
than `INSTAR_GAS_RESERVE` (default 0.05 SOL) plus one settlement, the queue
pauses and `/api/health` reports `settling: false`. The world keeps running;
nothing is lost; births simply wait.

Send SOL to the operator address (`operator.mts status` prints it) from any
wallet. The queue notices within a minute and resumes on its own. On mainnet
keep it at a few SOL, and alert on `operatorSol` below 0.2.

Getting money out of the world, the other way:

```
npx tsx scripts/operator.mts withdraw-treasury <to> <metabolism> <pool> --yes    # lamports, all, or 0
```

Metabolism sets carrying capacity (8 larvae plus 20 per SOL, up to 48), so
withdrawing it shrinks the dish on the next chain poll; the pool pays life
rewards, so withdrawing it makes the next reward batch scale down to what is
left. Neither touches a vault or a credit. Feeding it back in is
`fund <lamports> <pool_bps>`, and anyone may do that from any wallet.

## RPC failover

`INSTAR_RPC` is read once at start. To move endpoints, change it and restart;
the queue resumes from the journal, and every op re-reads the chain before
resending, so nothing is sent twice. Until then a dead endpoint shows as
`rpc.ok: false` (503) and a throttling one as `RPC rate limited` in the logs
with settlement backing off a minute at a time.

`/api/config` never reveals `INSTAR_RPC`; the site reads the public endpoint
for its own verification, and that one may be slow without affecting the
world.

## When the process dies

The supervisor restarts it. On boot it binds the port first (`/api/health`
answers `replaying` from then on), reloads the journal (or its `.bak` if the
journal is torn), resumes from the snapshot when the snapshot is no newer
than the journal (otherwise replays from genesis, which takes minutes and
shows as `tick` climbing towards `target` in `/api/health`), reconciles
identity with the program as under Restore, and drains whatever was queued.
A death or epoch that was sent but not confirmed at the moment of the crash
is looked up before it is sent again.

If it dies repeatedly: read the first `[instar]` error line. `REFUSING TO
START` is identity (Restore); `no operator keypair` and `REFUSING TO START on
mainnet-beta without INSTAR_MASTER_KEY` are environment; `the World account
… does not exist` means the wrong cluster or program id.

If the host is gone: a new host with the same environment and the latest
backup restored into `DATA_DIR` is the same world. The program never noticed.

## Key rotation

### Operator key

Two steps, and the old key signs until the second one lands:

```
npx tsx scripts/operator.mts transfer-operator <new pubkey> --yes         # signed by the current operator
INSTAR_OPERATOR_KEYPAIR=<new>.json npx tsx scripts/operator.mts accept-operator --yes   # signed by the new key
```

`accept-operator` refuses unless the key it signs with is the pending
operator. Fund the new key before accepting (it pays that fee and every
settlement after), and restart the world process with
`INSTAR_OPERATOR_KEYPAIR` pointing at it immediately after: until then every
op it sends is `NotOperator` and the queue holds (harmlessly). Every operator
instruction refreshes the heartbeat, so a rotation is also a heartbeat.

The recovery address moves with `set-recovery <pubkey> --yes` (operator only,
never the operator's own key, not once the world is winding down). Do it
before rotating the operator if the two are held by the same person.

### Master key

`INSTAR_MASTER_KEY` seals every custodial key in `accounts.json`. The world
cannot serve two keys at once and a record sealed under a key it does not
hold is quarantined at boot, not re-sealed — so a rotation is a re-encryption
of the file, done while the world is stopped:

```
# stop the world (rotate-master-key refuses while world.lock is held or anything answers on PORT)
npx tsx scripts/backup.mts                                     # first
node -e "require('fs').writeFileSync('new-master.key', require('crypto').randomBytes(32).toString('hex'), {mode: 0o600})"
export INSTAR_MASTER_KEY=$(cat /path/to/current/master.key)   # not pasted inline: that line is shell history
DATA_DIR=<dir> npx tsx scripts/operator.mts rotate-master-key new-master.key --yes
# start the world with INSTAR_MASTER_KEY set to the contents of new-master.key
```

The new key is read from a file, never from the command line (`ps` and the
shell history would hold it; the bare hex form is accepted on localnet
only). `npm run keys:new -- <dir>` writes a `master.key` too, but it mints an
operator, recovery and fee keypair beside it and refuses an existing
directory, so for a rotation make the one file as above. The command opens
every record under the current key before writing anything, so a wrong
current key changes nothing; afterwards `accounts.json` **and**
`accounts.json.bak` are both under the new key, so nothing sealed under the
retired key remains on the host — backups taken before the rotation still
are (see Backups). Localnet and devnet worlds started without
`INSTAR_MASTER_KEY` use a key derived from the operator keypair; the command
derives the same one when the variable is unset, which is how such a world
is moved onto an explicit key before its operator key is ever rotated.

## Re-offering a donated larva

A keeper can send a larva back to the dish with a plain Core transfer to the
World PDA (the custodial `/api/transfer` with the World PDA as `to`, or any
wallet). The record still says OWNED, held by an address no keeper can sign
for. The process never re-sells on its own; the operator does:

```
npx tsx scripts/operator.mts re-offer <id> <lamports> --yes
```

It prints the larva's state and refuses anything but a WILD larva or an OWNED
one whose asset is in the World PDA's hands. `open_offer` clears any stale
listing and puts the larva up at that price as if newborn; its vault travels
with it.

`force-settle-cull <id>` is the other by-hand settlement: a keeper asked for
a cull, the world's own settlement of it did not happen (the process was down
for the week), and after `CULL_TIMEOUT` anyone may close it — 85% of the
vault to the keeper's credit, the asset burned. The process handles culls in
the ordinary course; this is for the extraordinary one.

## Winding the world down

Deliberately, in this order. Every step is one-way.

1. **Announce it**, and stop selling: the site's copy is yours to change.
2. `npx tsx scripts/operator.mts begin-wind-down --yes`. From this slot the
   program refuses every birth, offer, sale, reward and `fund`; the process
   logs `THE WORLD IS WINDING DOWN` and stops queueing new life. Deaths and
   epochs still settle, so leave it running: every death moves a vault into
   credits keepers can withdraw.
3. Keepers exit on their own: `reclaim_vault` (the site's button) turns a
   living larva's vault into their credit and burns the asset; `withdraw`
   takes credit out. Tell them, and give them the 180 days.
4. `npx tsx scripts/operator.mts sweep-to-recovery --yes`: metabolism and
   pool to the recovery address. Anyone may send this; it touches no vault
   or credit.
5. After 180 days: `npx tsx scripts/operator.mts escheat --yes`. Everything
   above rent goes to recovery and the ledger is zeroed; any vault or credit
   nobody claimed goes with it. `TooEarly` before then, and the command says
   when.
6. Stop the process, take a last backup, and keep it: every Creature record
   and the burned assets' stubs stay readable on chain forever, and the
   journal is the only replayable history of what those larvae did.

If the operator key is simply gone, the same sequence happens without you:
after 90 days of silence anyone may call `begin_wind_down`, and steps 3 to 5
need no operator at all. `recovery` is fixed once wind-down begins, so a
stranger opening the exits cannot redirect them.
