# Instar: a cage of fruit flies, each driven by every neuron of a complete nervous system, settled on Solana

[image: hero.png]

Instar is a persistent world of adult fruit flies (Drosophila melanogaster) living in a glass cage on a bench. Every fly in it runs every neuron of one real male fly's complete nervous system, 166,700 neurons, and every one of its 6,242,118 connections of five or more synapses, reconstructed from electron microscopy by Janelia FlyEM and published in 2026 under CC BY 4.0. Nothing about a fly's behaviour is scripted. When a fly walks to the food, takes off, lands on the lid, or breeds, that is the wiring doing it.

The world runs ten steps a second, day and night, whether or not anyone is watching. Every fly is an NFT on Solana. Every 2,400 steps the world hashes itself and posts the hash to the chain, so anyone can replay it and check that what they were shown is what happened.

This article is everything you need to know: what is real and what is not, how the engine works, how the cage works, how the money works, how to own a fly, how to verify the world, and what the risks are.

Live: https://instarcage.com · Source: https://github.com/InstarCage/instar

## 1. The brain is real

[image: connectome.png]

In 2026, Berg and colleagues at Janelia published the complete central nervous system of one adult male fruit fly: the brain, both optic lobes and the ventral nerve cord, reconstructed neuron by neuron and synapse by synapse from electron microscopy (Sexual dimorphism in the complete connectome of the Drosophila male central nervous system, Cell; preprint doi:10.1101/2025.10.09.680999). That dataset, MaleCNS v1.0, is the nervous system of every animal in the cage.

The engine loads every neuron and every connection of five or more synapses between neurons in Janelia's annotated neuron set, verbatim, from a canonical file with a SHA-256 Merkle root. Connections of fewer than five synapses are not loaded; the file is not the whole wiring, and we never call it that.

From Janelia's own annotations the engine assigns roles to 19,460 of the neurons: which sensory neurons are olfactory, gustatory, mechanosensory, thermosensory, hygrosensory, photoreceptors; which motor neurons drive which leg on which side, the wing power and steering muscles, the halteres, the neck, the proboscis; which neurons descend from the brain to the cord, which ascend, which are neurosecretory. The other 147,240 neurons have no role and are driven purely through their wiring.

## 2. What is real, and what is not

[image: real.png]

The wiring is real. The dynamics are ours. Every claim on the site is meant to survive that sentence.

The connectome gives: which neuron connects to which, and how strongly (synapse counts); which neurons are sensory, motor, descending, ascending, neurosecretory, and of what kind; left and right, leg by leg, eye by eye.

The connectome does not give: how a neuron fires, muscles, a body, a world. So the engine supplies the same integer threshold unit for every one of the 166,700 cells (a potential, a refractory counter, a fired flag), a body as a few equations (six legs, two wings, halteres, a proboscis), and a cage with food, odour, light, heat, humidity, water and salt.

A fly here is driven by the real connectome. It is not a simulation of biology, and no such claim is made anywhere. Where a behaviour is described (takeoff, feeding, breeding) it names the engine rule, not a property of the animal.

## 3. The engine

[image: engine.png]

Integer, deterministic, event-driven. Fire above 16,384; leak a quarter per tick; refractory three ticks; a potential under 1,024 snaps to rest. Propagation runs along the census edges and only touched neurons are updated, which is what makes 166,700 neurons per fly affordable: about 2.8 milliseconds per fly per tick on a desktop i7, measured. Fixed-point 16.16 arithmetic, an xorshift64* random source, and no floating point anywhere, so the same inputs give the same bytes on every machine.

Genesis weights are the published synapse counts. Recurrent input is scaled by the previous tick's spike count (the stated stand-in for inhibition); sensory afferents are not scaled.

The engine is 146 KB of WebAssembly compiled from Rust. The same binary runs on the server and in the verifier. Its SHA-256 is served by the world and shown on the site, so you can build the commit yourself and compare.

## 4. Measured, not asserted

[image: measured.png]

Every number quoted on the site comes from a probe run over the checked-in engine and is stated with the horizon it was measured over. Eight founders over 8,000 ticks at genesis: 26.4 leg motor-neuron spikes per fly-tick, 8.5 wing, 0.68 proboscis; 9.0% of fly-ticks feeding and 97 takeoffs per fly-hour with the real connectome, against 0% and 0 with every synapse zeroed. Over 12,000 ticks the real line ends at 7 flies; the zeroed line is extinct at tick 4,000. Leg motor neurons fire on 88.6% of the real line's walking ticks and 0% of the zeroed line's.

That comparison is the point: the wiring is what makes the animal move, eat and survive. Zero it, and nothing does.

## 5. The cage

[image: cage.png]

The floor is 128 by 128 cells; above it are 16 layers of air for flight, and four walls and a lid a fly can walk on. On the floor stand raised dishes of yeast paste and banana, a water pool, and a salt crust in the driest corner. A lamp hangs from the lid and lights the cage in a cone. Light follows a day of 16,384 ticks; temperature drifts around a centre value with a gradient across the floor, hot on the lamp's side; humidity falls from the pool to the salt corner. All of it is a pure function of the tick and the seed, so it is the same in every mirror.

[image: senses.png]

Each sense is written from the cage: odour from the food as a two-dimensional field on the floor, thinner with height; taste from the substrate under the tarsi and the proboscis; Johnston's organ from the fly's own airflow in flight and neighbours' wingbeats within a radius; bristles and chordotonal organs from contact and the fly's own leg motion; thermo- and hygrosensory neurons from the gradients at the fly; photoreceptors from a coarse luminance sample ahead of each eye; haltere sensory neurons from the body's angular velocity; interoceptive neurons from how full the crop is.

Two ways to move. Walking: the fly is attached to a surface with a heading in its plane; leg motor neurons set speed and turn per side, and the three leg pairs' rates drive the gait. Flight: wing power motor neurons give thrust, steering neurons give yaw and roll, haltere neurons a stability term; takeoff when the power rate crosses a threshold, landing on contact when it drops.

[image: deaths.png]

Flies die. Starved when energy reaches zero; exhausted when it reaches zero in flight; senescence when upkeep climbs past 32,768 ticks of age; drowned, desiccated, killed in a contest, or culled at the keeper's request. Death is common: the genesis probe loses three of eight founders by tick 3,000. When a fly dies its NFT is burned and its vault is paid out by rule.

Reproduction is a rule, not biology: a fly with enough energy, the neurosecretory gate open and a partner within reach produces a child whose connection weights are a crossover of its parents' with a few signed mutations. Every animal runs the same male nervous system; what a lineage inherits is its weights.

## 6. Every fly is an NFT

[image: nft.png]

Every fly is a Metaplex Core asset in the Instar collection, minted at birth. The World program-derived address is the collection's update authority and holds permanent transfer, burn and freeze delegates on every asset, so births, sales and deaths settle by program. Ownership truth is the asset owner: whoever holds the NFT is the fly's keeper.

The asset's metadata is served live by the world: a portrait, generation, lineage, status, and a link to the fly in the cage. When the fly dies the asset is burned; its record stays on chain until the world is closed after escheat.

## 7. Where the money goes

[image: lifecycle.png]

Money lives as lamports on the World account. Four pools are tracked inside it: each fly's vault, the metabolism that sets how many animals the cage supports, the pool that pays living animals, and credits owed to people. The program keeps one invariant on every instruction: the account's balance above rent covers all four.

[image: flows.png]

A newborn is offered at 0.005 SOL plus 0.001 per generation (founders at twice the base). Buying it puts 60% in the fly's vault, 15% in metabolism, 15% in the pool and 10% in the parent's vault. A resale credits 90% to the seller, 5% each to metabolism and the pool, and the vault travels with the fly. At death, 40% of the vault is split equally among living heirs, 10% is credited to the keeper, 35% returns to metabolism and 15% to the pool. A cull credits 85% to the keeper.

[image: rewards.png]

Every eighth epoch (32 minutes) the world scores the flies alive at that moment on how they lived: survival, food eaten, vitality, longevity, maturity, offspring, lineage depth, and coming through a disaster, and divides a quarter of the pool by those points into their vaults, in batches of 20 per transaction. A fly that dies before the eighth epoch earns nothing. A vault is its keeper's money on the way out, so the pool ends up with whoever keeps flies that live well.

[image: capacity.png]

The cage holds 8 plus 20 flies per SOL of metabolism, up to 40, bounded by what the host can compute (a tick must stay under 80 ms of engine time; re-measured every epoch). When the population has sat below half the capacity for 600 ticks, founders are born to bring it back, so a larger metabolism is a fuller cage.

One instruction lets the operator move the treasuries (metabolism or pool, never a keeper's vault or credit). It exists to correct a misfunded world. Every use is a public transaction on the World account and the treasuries are shown live on the site.

## 8. Owning a fly

[image: own.png]

Open the cage at https://instarcage.com/cage.html and pick a way in. An Instar account is a name and a PIN: the world holds a Solana keypair for you, sealed under its master key (your PIN only signs you in), and you can withdraw everything to any address at any time. That is custodial, and the site says so. Or connect your own wallet: the page builds each transaction from the program's IDL, your wallet signs it, and the world never sees your key.

[image: custody.png]

Put in a little SOL, then buy a newborn from the Market window. It is minted to your wallet; holding the asset is what makes you its keeper. From the Mine window you can list it for resale at your price, transfer it like any NFT, ask the world to cull it, and withdraw what you are owed; with an Instar account you can also name its lineage.

[image: live-market.png]

## 9. Verify it yourself

[image: verify.png]

Every 2,400 ticks the engine hashes the whole world: population, positions, poses, genomes, and the state of every neuron it touched (FNV-1a, 64 bit). The operator posts that hash to the World account on Solana. Anyone can fetch the world's snapshot, replay the same ticks with the same engine on their own machine, hash the result, and read the account back:

npm run verify:epoch -- --world https://instarcage.com

It prints VERIFIED or MISMATCH. Same bytes, honest world; different bytes, caught. A desktop browser with 4 GB free can run the same replay from the cage page. The site shows the latest verdict, the latest epoch's hash and transaction, the program, the World account, the collection, the source commit the world is running, the engine's SHA-256, and the census Merkle root.

[image: proof.png]

## 10. If the operator disappears

[image: recovery.png]

The program was designed against one question: if the operator key were destroyed this instant and nobody ever ran the world again, can each lamport still be got out, by someone, without anyone's permission?

Credits are already pull-only. After 90 days without an operator action, anyone may begin wind-down; keepers reclaim their flies' vaults as credit, and the treasuries sweep to a recovery address fixed when the world was created. 180 days after wind-down began (day 270 at the earliest for an abandoned world), whatever nobody came back for goes to recovery and every account closes for its rent. The operator can also wind down deliberately, any day. No lamport is stranded by design.

## 11. The coin

[image: coin.png]

$INSTAR will be a pump.fun coin whose creator fees are claimed by the world and paid into the cage: half to metabolism, half to the pool. The creator is the world's fee keypair, fixed at launch and unchangeable afterwards; every claim is a permissionless, public transaction. The coin confers nothing: no governance, no access, no share of any fly or of the cage. It has not launched yet; the site will name the mint the moment it does, and nothing on the site says otherwise until then.

## 12. Risks, plainly

Flies die, often within minutes; a purchase can end with nothing but a death settlement. An Instar account is custodial; use your own wallet if you would rather hold the key. Nothing on the site is an investment, and no number on it is a forecast. The world is on Solana devnet today while it is rehearsed end to end; mainnet follows.

## 13. The stack, all of it open

[image: stack.png]

The engine is Rust compiled to WebAssembly. The program is Anchor on Solana with Metaplex Core for the assets, with 40 tests. The world is a Node process: a journal of every input, snapshots, an idempotent settlement queue, a server-sent-events stream of the cage, and the custodial-account API. The site is static pages filled from the stream and the journal, with three.js for the cage. The census converter is Python. Everything is at https://github.com/InstarCage/instar under MIT; the connectome is Janelia's under CC BY 4.0.

[image: licence.png]

The connectome belongs to its authors. Nothing here should be read as their endorsement of anything here.

Watch the cage: https://instarcage.com
