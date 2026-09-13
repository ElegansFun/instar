# Instar

A persistent world of *Drosophila melanogaster* first-instar larvae, each driven
by the real larval brain connectome, settled on Solana.

Every larva runs the whole-brain wiring published by Winding et al. in 2023:
2,952 neurons and 110,677 chemical synapses, the complete brain of a
first-instar larva reconstructed from electron microscopy. That graph, with its
published synapse counts as the starting weights, is the animal's genome. Its
olfactory neurons smell the yeast ahead of it; its descending neurons drive its
crawl and its pharynx; its ring-gland cells gate when it can breed. It hatches,
eats, molts, breeds and dies, and each of those is a record on Solana. The
larva is the asset: every larva is a Metaplex Core NFT in the Instar
collection. Buying one puts it in your wallet, resale moves it, death burns
it, and the vault of SOL it earned travels with it.

## What is actually real

This project's one non-negotiable rule is that it never claims more than it can
show. Precisely:

The connectome is the Winding et al. 2023 dataset, converted to a canonical
format and Merkle-rooted (`data/canonical/`, root
`20bf96b024a0443cef186773d7c1bf615c9f46377c02480fc31edad5a3096b5a`). The
engine loads every node and every weighted edge of it. Neurons are identical
integer threshold units (potential, leak, refractory counter); the dataset does
not give neuron dynamics, synapse polarity, neuromodulation, the ventral nerve
cord or the muscles, so those are the engine's own few equations, stated in
`sim/src/lib.rs`. Sensory and motor roles come from the paper's own
annotations: olfactory, gustatory, thermosensory, visual and gut sensory
neurons; mechanosensory, proprioceptive and nociceptive ascending neurons;
descending neurons to the nerve cord (left, right) and to the feeding
apparatus; the ring gland. A larva here is *descended from* the real larval
connectome. It is not a real larva and it does not behave exactly like one.

Measured, not asserted, and re-measured on every build (`npm run sim:gates`):

| | |
|---|---|
| descending-neuron firings per larva-tick (182 DN-VNC cells) | **4.74** at 8,000 ticks |
| ticks spent feeding, real genome vs every synapse zeroed | **14.7% vs 0.0%** at 8,000 ticks |
| a dish of zeroed-genome larvae | **extinct by tick 2,223** |
| the real line at 12,000 ticks | **7 alive, 17 births, generation 4** |
| engine cost at 40 larvae | **1.54 ms per tick**, one core |

Generation zero does not find food better than a random walk would; it eats
because its descending neurons drive the pharynx when it is standing on food,
and the zeroed line starves because they do not. Whether selection improves on
that is what the dish is for.

## Every lamport has a way out

A world that holds other people's money has one unforgivable failure: a
balance whose only exit runs through a key, or a process, that stopped
existing. The program is built so that cannot happen:

> Every balance the program holds has an exit that **anyone** may call, sending
> to a destination **fixed at initialisation**.

With every key destroyed, a keeper still reclaims their larva's vault, anyone
sweeps the treasuries to the recovery address, and six months after wind-down
anything nobody came back for follows them. Ninety days of operator silence
lets a stranger open those doors; the stranger cannot benefit. The tests that
state this run on every build (`docs/PROGRAM.md`).

## Layout

| Path | What it is |
|---|---|
| `sim/` | The engine. Integer-only deterministic Rust, one crate for WASM and native. Same seed, same dish, bit for bit. |
| `program/` | The Anchor program: registry, market, treasuries, epoch commitments, recovery; every larva a Metaplex Core NFT in the world's collection. |
| `services/world/` | The world process: hosts the engine, journals every input, commits a state hash each epoch, settles births, deaths and rewards, claims the coin's fees, serves the site and the custodial-account API. |
| `services/chain/` | `solana.mts` (the only module that signs on the server), `fees.mts` (pump.fun creator-fee claims), the program IDL. |
| `site/` | The dish, rendered as a petri dish from the engine's own state; the market; the census. Runs the same engine in the browser and verifies every posted epoch hash against the World account. Custodial accounts or your own wallet. |
| `scripts/` | Build, probes, deploy, preflight, operator CLI, backups, fee claims, verification. |
| `data/canonical/` | The connectome, converted and Merkle-rooted. This is the file that gets hashed. |
| `tools/census/` | The converter and verifier. Python standard library only. |
| `docs/` | The program, the economy, the coin, the schema, the licence position, going live, running it afterwards. |

## Running it

```bash
npm install
npm run sim:build          # native tests, WASM build, then the probe gates
cd program && npm install && cd ..
npm run program:build      # the on-chain artifact and its IDL
npm run localnet           # a validator with the program preloaded (keep it running)
npm run world:init         # init_world on that validator
npm run world              # the world, on http://localhost:8787
```

Verifying it, all against real validators rather than mocks:

```bash
npm run program:test       # the program: 36 flows, splits to the lamport, both recovery drills
npm run localnet -- 8999   # a scratch validator for the next line
INSTAR_RPC=http://127.0.0.1:8999 npm run verify   # the chain module the world uses
npm run journey            # the API a person uses: sign up, buy, list, transfer, cash out
npm run roles:check        # the three role maps (engine host, browser, probes) are identical
npm run census:verify      # the Merkle root of the connectome file
```

Going live: `docs/MAINNET.md`. In short: `npm run keys:new -- .keys/mainnet
--program` mints every key, `npm run preflight` proves the machine, the keys,
the artifact and the cluster agree before a lamport moves, and `npm run
program:deploy` deploys and creates the world in one run. The coin and its
fees: `docs/COIN.md`. Day two: `docs/OPERATIONS.md` (`npm run operator`,
`npm run backup`, `npm run fees`). The container Railway runs is the
`Dockerfile`; `scripts/wsl-docker.sh` builds and smoke-runs it locally.


## Licence position

The code is MIT. The dataset is not the code: the Winding et al. 2023
connectivity data is used from its author-manuscript deposit on Europe PMC
(PMC7614541), which is CC BY 4.0. The provenance block of the canonical file
records the exact files and their SHA-256. See `docs/LICENSES.md`.
