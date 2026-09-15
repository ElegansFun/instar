// The day's posting schedule: 72 posts, one every 20 minutes, written to
// brand/social/schedule.json. Each post is a card plus a text; the texts
// that quote the world read brand/social/.config.json and .journal.json at
// generation time, so refetch those first. The poster (brand/post.mjs)
// reads the schedule and posts what is due.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, "social");
const cfg = JSON.parse(fs.readFileSync(path.join(out, ".config.json"), "utf8"));
const j = JSON.parse(fs.readFileSync(path.join(out, ".journal.json"), "utf8"));
const meas = JSON.parse(fs.readFileSync(path.join(dir, "..", "site", "measurements.json"), "utf8"));
const m = Object.fromEntries(meas.items.map(i => [i.label, i]));
const n = (v) => Number(v).toLocaleString("en-US");
const rc = cfg.roleCounts, groups = cfg.groups;
const gsum = (g) => groups[g].reduce((a, r) => a + (rc[r] || 0), 0);
const eco = cfg.economy;
const sol = (l) => (Number(l) / 1e9).toString();
const alive = j.flies.filter(f => f.status !== 4).length, dead = j.flies.filter(f => f.status === 4).length;
const life = j.flies.filter(f => f.status === 4 && f.deathTick > f.birthTick).map(f => f.deathTick - f.birthTick).sort((a, b) => a - b);
const med = life.length ? Math.round(life[life.length >> 1] / j.tickrate / 60) : null;
const v = j.verifier, last = j.epochs[j.epochs.length - 1];
const epochMin = j.epochInterval / j.tickrate / 60;
const U = "instarcage.com";

// every text is one fact or one rule, with the card that shows it
const base = [
  ["connectome", `${n(cfg.nodes)} neurons. ${n(cfg.edges)} connections of five or more synapses. One adult male Drosophila, brain, optic lobes and nerve cord, from Janelia's MaleCNS v1.0. Every fly in the cage runs all of it. ${U}`],
  ["real", `What is real: the wiring, who connects to whom and how strongly, and which cells are sensory, motor, descending, ascending. What is ours: one threshold rule per neuron, a body of a few equations, a cage. We say driven by the connectome, never simulation of biology.`],
  ["engine", `Fire above 16,384. Leak a quarter per tick. Refractory 3 ticks. Fixed-point 16.16, no floats anywhere, so the same inputs give the same bytes on every machine. ${m["engine time per fly-tick; the world caps its population at floor(80 ms / this)"].value.split(" ")[0]} ms per fly per tick, measured.`],
  ["measured", `Same engine, same cage, every synapse zeroed as the control. Real: ${m["fly-ticks feeding, real connectome vs every synapse zeroed"].value.split(" vs ")[0]}% of ticks feeding, ${m["takeoffs per fly-hour at 10 ticks/s, real vs zeroed"].value.split(" vs ")[0]} takeoffs per fly-hour. Zeroed: 0 and 0. The wiring is what makes the animal move.`],
  ["senses", `What the cage writes into each sense: odour as a field on the floor, taste from the substrate under the tarsi, Johnston's organ from airflow and neighbours' wingbeats, bristles from contact, thermo and hygro from the gradients, photoreceptors from the light ahead. ${n(gsum("sens"))} sensory neurons take it.`],
  ["cage", `The cage: ${cfg.arena.floor}×${cfg.arena.floor} floor cells, ${cfg.arena.layers} layers of air, four walls and a lid a fly can walk on, dishes of yeast and banana, a water pool, a salt crust, a lamp that dims at night. All a pure function of tick and seed, so every mirror sees the same world.`],
  ["deaths", `Flies die. Starved, exhausted mid-flight, drowned, desiccated, killed, culled. The median fly in this world so far lived ${med} minutes (${life.length} deaths). Death burns the NFT; the vault pays out by rule. ${U}`],
  ["lifecycle", `A fly's life, and where the money goes. Born: crossover of its parents' weights, minted, offered. Bought: 60% vault, 15% metabolism, 15% pool, 10% parent. Lives: every eighth epoch the flies alive are scored and share a quarter of the pool. Dies: NFT burned; 40% heirs, 10% keeper, rest to the cage.`],
  ["flows", `Every flow in the ledger, by rule. Four pools in one program account: vaults, metabolism, pool, credits. One invariant checked on every instruction: the balance above rent covers all four.`],
  ["rewards", `Earning by living. Every ${eco.rewardEveryEpochs}th epoch (${Math.round(epochMin * eco.rewardEveryEpochs)} minutes) the flies alive at that moment are scored: survival, foraging, energy, age, maturity, births, generation. A quarter of the pool is divided by those points into their vaults. A fly dead before then earns nothing.`],
  ["nft", `Every fly is a Metaplex Core NFT, minted at birth into the Instar collection. Whoever holds it is the keeper. The World PDA holds permanent transfer, burn and freeze delegates, so births, sales and deaths settle by program. ${n(j.flies.length)} minted so far on ${j.cluster}; ${dead} burned.`],
  ["breeding", `Reproduction is a rule, not biology. Energy above 45,000, the neurosecretory gate open (${gsum("neuro")} neurons), a partner within reach: the child's weights are a crossover of its parents' with a few signed mutations. What a lineage inherits is its weights.`],
  ["flight", `Flight is driven by ${gsum("wingP")} wing power and ${gsum("wingS")} steering motor neurons. Takeoff when the smoothed power rate reaches 4 spikes per tick; halteres a stability term; landing on contact. It costs 20-28× what standing does, which is why so many flies die exhausted mid-air.`],
  ["capacity", `Carrying capacity is the smaller of two numbers: the economy's (8 + 20 flies per SOL of metabolism, up to 40) and compute (a tick under 80 ms of engine time, re-measured every epoch). Right now: ${alive} alive, capacity ${j.capacity}, metabolism ${sol(j.metabolism).slice(0, 6)} SOL.`],
  ["custody", `Two ways in. An Instar account: a name and a PIN; the world holds a keypair for you, sealed under its master key. Custodial, the operator can spend from it, and the site says so. Or your own wallet: the page builds each transaction from the IDL, your wallet signs, the world never sees your key.`],
  ["own", `How to own a fly: open the cage, make an account or connect a wallet, put in a little SOL (test SOL on ${j.cluster}, free from the Airdrop button), buy a newborn from the Market window. A newborn is ${sol(eco.offerBase)} SOL + ${sol(eco.offerPerGen)} per generation; founders ×${eco.founderPremium}. ${U}/cage.html`],
  ["verify", `Don't take the operator's word.\n\nnpm run verify:epoch -- --world https://${U}\n\nIt fetches the snapshot, replays the epoch with the same engine and reads the World account on Solana. Same bytes, honest. Latest: ${v ? `${v.verdict} at epoch ${v.epoch}` : "no result posted"}.`],
  ["proof", `What this world is, verifiably: program ${j.programId.slice(0, 8)}…, World account ${j.worldPda.slice(0, 8)}…, source commit ${(cfg.build.commit || "").slice(0, 10)}, engine sha-256 ${cfg.build.wasmSha256.slice(0, 12)}…, census root ${cfg.build.censusRoot.slice(0, 12)}…. All on the site, all checkable against the chain and the repo.`],
  ["recovery", `If the operator disappears: after 90 days without an operator action anyone may begin wind-down; keepers reclaim their vaults; 180 days after wind-down began the rest sweeps to a recovery address and every account closes for its rent. No lamport is stranded by design.`],
  ["stack", `All of it is open: engine (Rust → WebAssembly, ${n(meas.wasm_bytes)} bytes), Solana program (Anchor + Metaplex Core, 42 tests), world process (Node), site, census converter (Python), verifier. github.com/InstarCage/instar, MIT. The connectome is Janelia's, CC BY 4.0.`],
  ["now", `Right now on ${j.cluster}: ${alive} alive of capacity ${j.capacity}, ${n(j.flies.length)} born, ${dead} died, ${j.epochs.length} epochs posted, latest ${last.epoch} at tick ${n(last.tick)}. Read from the world's journal, the same one you can fetch at ${U}/api/journal.`],
  ["licence", `Whose work this stands on: Berg et al. 2026, Janelia FlyEM. The complete connectome of a male Drosophila central nervous system, MaleCNS v1.0, CC BY 4.0. The census here is a byte-verifiable conversion of their data. It belongs to its authors; nothing here is their endorsement.`],
  ["hero", `A cage of flies, each driven by every neuron of a complete nervous system. Every fly an NFT. Every epoch hashed to Solana. Watch it live: ${U}`],
  ["coin", `$INSTAR ${cfg.coin && cfg.coin.mint ? "is live" : "is not launched yet"}. When it is, its creator fees are claimed by the world and paid into the cage: half to metabolism (capacity), half to the pool (rewards). No governance, no access, no share of anything. The site will name the mint; nothing else does.`],
];
// second-pass variants so the 24 hours are not three identical cycles
const alt = [
  ["connectome", `Roles from Janelia's annotations: ${n(gsum("sens"))} sensory, ${n(gsum("dn"))} descending, ${n(gsum("an"))} ascending, ${n(gsum("legL") + gsum("legR"))} leg motor, ${n(gsum("wingP") + gsum("wingS"))} wing motor, ${n(gsum("prob"))} proboscis, ${n(gsum("neuro"))} neurosecretory. The other ${n(rc[0])} have no role and are driven by wiring alone.`],
  ["engine", `Propagation is event-driven along the census edges: only neurons that received a spike are updated. That is what makes ${n(cfg.nodes)} neurons per fly affordable. ${m["engine memory at 40 flies (genomes, wiring, per-fly neural state)"].value} MB for 40 flies, all in one WebAssembly memory.`],
  ["measured", `Over ${m["population at the horizon, real connectome vs every synapse zeroed"].horizon.split(",")[0]}: the real line ends with ${m["population at the horizon, real connectome vs every synapse zeroed"].value.split(" vs ")[0]} flies alive; the zeroed line is extinct at tick ${m["zeroed-synapse line extinct at tick"].value}. Leg motor neurons fire on ${m["walking fly-ticks with leg motor-neuron output, real vs zeroed"].value.split(" vs ")[0]}% of the real line's walking ticks; 0% of the zeroed.`],
  ["verify", `Every ${n(j.epochInterval)} ticks the engine hashes the whole world: every fly, every position, every neuron it touched (FNV-1a, 64 bit). The operator posts the hash to the World account. ${j.epochs.length} posted so far; the latest is ${last.hash}. Anyone can replay and compare.`],
  ["custody", `Which key holds your fly is your choice, and the site states the trade plainly: Instar account, quick and custodial; your wallet, yours alone. Either way, withdrawing what you are owed is pull-only. Nobody needs anyone's permission to take their money out.`],
  ["deaths", `Death settlement by rule: 40% of the vault to the fly's living children, 10% credited to the keeper, 35% back to metabolism, 15% to the pool. No living children: the 40% goes to the cage. A cull the keeper asked for: 85% to the keeper.`],
  ["capacity", `Below half capacity for 600 ticks, founders are born back to capacity. So a bigger metabolism is a fuller cage, and the cage never sits empty. Capacity is re-measured every epoch and never below 8.`],
  ["nft", `Holding the asset is what makes you the keeper; there is no separate registry. Transfer it anywhere. But a fly parked in a marketplace escrow when it dies has no keeper who can sign, so the keeper's 10% goes to the cage. List it through the cage instead.`],
];
const altMap = Object.fromEntries(alt.map(([k, t]) => [k, t]));
const posts = [];
for (let cycle = 0; cycle < 3; cycle++) for (const [media, text] of base) {
  const t = cycle === 1 && altMap[media] ? altMap[media] : text;
  posts.push({ media: media + ".png", text: t });
}
const schedule = posts.slice(0, 72).map((p, i) => ({ at: Date.now() + i * 20 * 60_000, ...p, posted: null }));
for (const p of schedule) if (p.text.length > 500) throw new Error(`too long (${p.text.length}): ${p.text.slice(0, 40)}`);
fs.writeFileSync(path.join(out, "schedule.json"), JSON.stringify(schedule, null, 1) + "\n");
console.log(`${schedule.length} posts, first at ${new Date(schedule[0].at).toISOString()}, last at ${new Date(schedule[schedule.length - 1].at).toISOString()}`);
