# Instar

A persistent world of adult *Drosophila melanogaster*, each fly driven by a
real fly's complete nervous system, settled on Solana.

Every fly runs the Janelia MaleCNS connectome (Berg et al., Cell 2026): the
whole central nervous system of one adult male fruit fly reconstructed from
electron microscopy — central brain, both optic lobes and the ventral nerve
cord — 166,700 neurons, and every connection between them of five or more
synapses, 6,242,118 of them. That graph, with its synapse counts as the
starting weights, is the animal's genome. Its olfactory neurons smell the
yeast across the cage; its photoreceptors see the lamp; its descending
neurons drive leg motor neurons to walk and wing motor neurons to fly; its
proboscis motor neurons feed it; its neurosecretory cells gate when it can
breed. It is born, eats, walks, flies, breeds and dies, and each of those is a
record on Solana. The fly is the asset: every fly is a Metaplex Core NFT in
the Instar collection. Buying one puts it in your wallet, resale moves it,
death burns it, and the vault of SOL it earned travels with it.

## What is actually real

This project's one non-negotiable rule is that it never claims more than it can
show. Precisely:

The connectome is the Janelia MaleCNS v1.0 release, converted to a canonical
binary and Merkle-rooted (`data/canonical/`, root
`a7999c12b33dd7a5681541b7b9025c165b236b40cb76117885d5663e839b196e`). The
engine loads **every neuron of the connectome, and every connection of five or
more synapses**; connections of one to four synapses are not loaded, so this
is not the whole wiring. The dataset gives wiring and synapse counts. It does
not give neuron dynamics, synapse polarity, neuromodulation, muscles or a body,
so the engine supplies the same integer threshold unit for every neuron and a
body of a few equations: six legs, two wings, halteres, a proboscis. Sensory
and motor roles come from Janelia's own annotations (19,460 neurons carry
one): olfactory, gustatory, mechanosensory, chordotonal, thermo- and
hygrosensory, photoreceptors of each eye, haltere afferents; leg, wing, neck,
proboscis and abdominal motor neurons by nerve and muscle; descending and
ascending neurons; neurosecretory cells. A fly here is *descended from* the
real fly's connectome. It is not a real fly and it does not behave exactly
like one.

Measured, not asserted, and re-measured on every build (`npm run sim:gates`,
which also writes `site/measurements.json`), 8 founders over 8,000 ticks
unless stated, generation zero running the published synapse counts:

| | |
|---|---|
| motor-neuron firings per fly-tick | legs **26.4**, wings **8.5**, proboscis **0.68** |
| ticks spent feeding, real genome vs every synapse zeroed | **9.0% vs 0.0%** |
| takeoffs per fly-hour at 10 ticks/s, real vs zeroed | **97 vs 0** (9.6% of fly-ticks in flight) |
| a cage of zeroed-genome flies | **extinct by tick 4,000** |
| the real line at 12,000 ticks | leg motor neurons fire on **88.6%** of its walking ticks (zeroed: 0%) |
| engine cost | **2.8 ms per fly-tick**; 40 flies is 113 ms per tick on one core (i7-14700K) |

The last line is why the world runs at 10 ticks per second and carrying
capacity is bounded by compute as well as by the economy (`docs/ECONOMY.md`).
Generation zero does not find food better than chance; it eats because its
proboscis motor neurons fire when it is standing on food, and it flies because
its wing motor neurons fire, and the zeroed line does neither. Whether
selection improves on that is what the cage is for.

## Every lamport has a way out

A world that holds other people's money has one unforgivable failure: a
balance whose only exit runs through a key, or a process, that stopped
existing. The program is built so that cannot happen:

> Every balance the program holds has an exit that **anyone** may call, sending
> to a destination **fixed at initialisation**.

With every key destroyed, a keeper still reclaims their fly's vault, anyone
sweeps the treasuries to the recovery address, and six months after wind-down
anything nobody came back for follows them; after that every record closes
for its rent. Ninety days of operator silence lets a stranger open those
doors; the stranger cannot benefit. The tests that state this run on every
build (`docs/PROGRAM.md`); the end-of-life procedure is `docs/RECOVERY.md`.

## Layout

| Path | What it is |
|---|---|
| `sim/` | The engine. Integer-only deterministic Rust, one crate for WASM and native, event-driven over 166,700 neurons per fly. Same seed, same cage, bit for bit. |
| `program/` | The Anchor program: registry, market, treasuries, epoch commitments, recovery; every fly a Metaplex Core NFT in the world's collection. |
| `services/world/` | The world process: hosts the engine, journals every input, commits a state hash each epoch, settles births, deaths and rewards, claims the coin's fees, streams the cage to browsers, serves the site and the custodial-account API. |
| `services/chain/` | `solana.mts` (the only module that signs on the server), `fees.mts` (pump.fun creator-fee claims), the program IDL. |
| `site/` | Four pages, all filled from the world's stream and journal: `index.html` (what Instar is, how it works, how to own a fly, the coin, how to verify, questions), `cage.html` (the live cage with the market and your account: custodial or your own wallet), `paper.html` (the technical account: what is real, the brain by role, the cage's senses, the ledger's rules, the record, licence), `coin.html` ($INSTAR and its fee flow, live). Epoch hashes are verified against the World account by the CLI verifier, or in a desktop browser on demand. |
| `scripts/` | Build, probes, deploy, preflight, operator CLI, backups, fee claims, verification. |
| `data/canonical/` | The connectome, converted and Merkle-rooted. These are the files that get hashed. |
| `tools/census/` | The converter and verifier (Python; pyarrow only for reading Janelia's feather files). |
| `docs/` | The program, the economy, the coin, the schema, the licence position, going live, running it afterwards, ending it. |

## Running it

```bash
npm install
pip install pyarrow
python -m tools.census fetch malecns      # 1.05 GB from Janelia's public bucket
python -m tools.census convert malecns    # ~30 s: data/canonical/male-cns-v1.0.*
npm run sim:build          # native tests, WASM build, then the probe gates (~15 min)
cd program && npm install && cd ..
npm run program:build      # the on-chain artifact and its IDL
npm run localnet           # a validator with the program preloaded (keep it running)
npm run world:init         # init_world on that validator
npm run world              # the world, on http://localhost:8787 (needs ~1 GB RAM)
```

Verifying it, all against real validators rather than mocks:

```bash
npm run program:test       # the program: 40 flows, splits to the lamport, both recovery drills
npm run localnet -- 8999   # a scratch validator for the next line
INSTAR_RPC=http://127.0.0.1:8999 npm run verify   # the chain module the world uses
npm run journey            # the API a person uses: sign up, buy, list, transfer, cash out
npm run verify:epoch       # replay an epoch and compare with the World account on chain
npm run roles:check        # the three role maps (engine host, browser, probes) are identical
npm run census:verify      # the Merkle root of the connectome files
```

Going live: `docs/MAINNET.md`. In short: `npm run keys:new -- .keys/mainnet
--program` mints every key, `npm run preflight` proves the machine, the keys,
the artifact and the cluster agree before a lamport moves, and `npm run
program:deploy` deploys and creates the world in one run. The coin and its
fees: `docs/COIN.md`. Day two: `docs/OPERATIONS.md` (`npm run operator`,
`npm run backup`, `npm run fees`). The end: `docs/RECOVERY.md`. The container
Railway runs is the `Dockerfile`; `scripts/wsl-docker.sh` builds and
smoke-runs it locally.

## Licence position

The code is MIT. The dataset is not the code: the Janelia MaleCNS v1.0
connectome is CC BY 4.0, cited and attributed wherever it appears, and the
canonical header records the exact source files and their SHA-256. See
`docs/LICENSES.md`.
