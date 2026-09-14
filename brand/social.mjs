// Cards for X: 1600x900, the brand's paper and ink, every number read from
// the world (brand/social/.config.json, .journal.json fetched from the live
// host) or from site/measurements.json. Writes brand/social/compose.html;
// screenshot every [data-asset] at its box (the same way brand/build.mjs's
// output is rasterised).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(dir, "..", "site");
const out = path.join(dir, "social");
const cfg = JSON.parse(fs.readFileSync(path.join(out, ".config.json"), "utf8"));
const journal = JSON.parse(fs.readFileSync(path.join(out, ".journal.json"), "utf8"));
const meas = JSON.parse(fs.readFileSync(path.join(site, "measurements.json"), "utf8"));
const fly = fs.readFileSync(path.join(dir, "fly.svg"), "utf8");
const n = (v) => Number(v).toLocaleString("en-US");
const sol = (l) => (Number(l) / 1e9).toFixed(4);
let k = 0;
const plate = (bold = 1.4) => fly.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"').replace(/viewBox="[^"]+"/, 'viewBox="16 16 268 222"')
  .replace(/stroke-width="([\d.]+)"/g, (_, w) => `stroke-width="${(Number(w) * bold).toFixed(2)}"`)
  .replace(/id="(\w+)"/g, (_, i) => `id="${i}-${k}"`).replace(/href="#(\w+)"/g, (_, i) => `href="#${i}-${k}"`) + (k++, "");

const rc = cfg.roleCounts, groups = cfg.groups;
const gsum = (g) => groups[g].reduce((a, r) => a + (rc[r] || 0), 0);
const alive = journal.flies.filter(f => f.status !== 4).length;
const dead = journal.flies.filter(f => f.status === 4).length;
const births = journal.flies.length;
const epochs = journal.epochs || [];
const last = epochs[epochs.length - 1];
const v = journal.verifier;
const b = cfg.build || {};
const m = Object.fromEntries(meas.items.map(i => [i.label, i]));

const card = (id, body, cls = "") => `<div data-asset="${id}" class="card ${cls}">${body}<div class="foot"><span>instarcage.com</span><span>Drosophila melanogaster · Janelia MaleCNS v1.0 · Solana</span></div></div>`;
const head = (eyebrow, title) => `<div class="eyebrow">${eyebrow}</div><h1>${title}</h1>`;
const table = (rows, ths) => `<table>${ths ? `<thead><tr>${ths.map(t => `<th>${t}</th>`).join("")}</tr></thead>` : ""}<tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i > 0 && /^[\d.,%\u2014 –-]+( SOL|%)?$/.test(String(c)) ? "n" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

const cards = [
  card("hero", `<div class="split"><div>${head("A persistent world, settled on Solana", "A cage of flies,<br>each driven by every neuron<br>of a <i>complete nervous system.</i>")}<p class="lede">Every fly runs every neuron of one real fruit fly's nervous system and every connection of five or more synapses. Nothing scripted. Every fly an NFT. Every epoch hashed to Solana.</p></div><div class="art">${plate()}</div></div>`),

  card("connectome", `${head("The brain", `${n(cfg.nodes)} neurons. ${n(cfg.edges)} connections.`)}<p>One adult male <i>Drosophila melanogaster</i>: brain, both optic lobes and the ventral nerve cord, reconstructed from electron microscopy by Janelia FlyEM (Berg et al. 2026). Every connection of five or more synapses, loaded verbatim. CC BY 4.0.</p>
  <div class="cols">${table([["sensory neurons", n(gsum("sens"))], ["descending neurons", n(gsum("dn"))], ["ascending neurons", n(gsum("an"))], ["leg motor neurons", n(gsum("legL") + gsum("legR"))], ["wing motor neurons (power + steering)", n(gsum("wingP") + gsum("wingS"))], ["haltere, proboscis, neurosecretory", n(gsum("haltere") + gsum("prob") + gsum("neuro"))], ["interneurons, driven by wiring alone", n(rc[0])]])}
  <div class="art small">${plate()}</div></div>`),

  card("real", `${head("What is real", "The wiring is real. The dynamics are ours.")}<div class="cols two"><div><h3>The connectome gives</h3><ul><li>which neuron connects to which, and how strongly (synapse counts)</li><li>which are sensory, motor, descending, ascending, neurosecretory, and of what kind</li><li>left and right, leg by leg, eye by eye</li></ul></div><div><h3>The engine supplies</h3><ul><li>one integer threshold unit for every cell: potential, leak, refractory</li><li>a body: six legs, two wings, halteres, a proboscis, as a few equations</li><li>a cage: food, odour, light, heat, humidity, water, salt</li></ul></div></div><p class="note">We say <i>driven by</i> the real connectome. We never say simulation of biology.</p>`),

  card("engine", `${head("The engine", "Integer. Deterministic. Event-driven.")}${table([["neuron model", "threshold unit: fire above 16,384; leak a quarter per tick; refractory 3 ticks"], ["propagation", "event-driven along the census edges; only touched neurons are updated"], ["arithmetic", "fixed point 16.16, xorshift64*; no floating point anywhere"], ["tick rate", "10 ticks per second; epoch every 2,400 ticks"], ["cost", "2.8 ms per fly-tick on an i7-14700K (40 flies, 400 ticks, sim-bench)"], ["memory", "641 MB at 40 flies; the whole world is one WebAssembly linear memory"], ["binary", `instar_sim.wasm, ${n(meas.wasm_bytes)} bytes, sha-256 ${b.wasmSha256 ? b.wasmSha256.slice(0, 24) + "…" : "—"}`]])}`),

  card("measured", `${head("Measured, not asserted", "What the wiring does, with its horizon.")}<div class="grid3">${meas.items.slice(0, 9).map(i => `<div class="m"><div class="v">${i.value}${i.unit ? `<small>${i.unit}</small>` : ""}</div><div class="k">${i.label}</div><div class="h">${i.horizon}</div></div>`).join("")}</div>`),

  card("senses", `${head("The cage, as the fly senses it", "What the engine writes into each sense.")}${table([["olfactory", "odour from the food as a field on the floor, thinner with height"], ["gustatory, leg taste", "the substrate under the tarsi and the proboscis"], ["Johnston's organ", "own airflow in flight; neighbours' wingbeats within a radius"], ["bristle, chordotonal", "contact, and the fly's own leg motion"], ["thermo, hygro", "temperature and humidity gradients at the fly"], ["photoreceptors R1–6, R7/8, ocellar", "an 8×2 luminance sample ahead of each eye, the lamp's colour, light overhead"], ["haltere sensory", "the body's angular velocity"], ["interoceptive", "how full the crop is"]])}`),

  card("cage", `${head("The cage", "A glass box with weather.")}<div class="cols two"><div>${table([["floor", `${cfg.arena.floor} × ${cfg.arena.floor} cells`], ["air", `${cfg.arena.layers} flight layers`], ["surfaces", "floor, four walls, lid; flies walk on all six"], ["dishes", `${cfg.arena.dishes.filter(d => d.kind !== "water").length} of yeast paste and banana, a water pool, a salt crust`], ["day", "16,384 ticks; the lamp dims at night"], ["climate", "temperature gradient from the lamp; humidity from pool to salt"]])}</div><div><p>All of it is a pure function of the tick and the seed: the same in every mirror, which is what makes the world verifiable.</p><p>Odour is a chamfer field refreshed every 8 ticks. Food regrows toward its substrate ceiling. A purchase provisions the buyer's fly.</p></div></div>`),

  card("deaths", `${head("Death", "What kills a fly.")}${table([["starved", "energy reaches zero; a fly whose proboscis motor neurons stay silent on food cannot eat"], ["exhausted", "flight with no energy left: the fly falls"], ["senescence", "past 32,768 ticks upkeep climbs by one per 256 ticks; no age limit"], ["drowned / desiccated", "too long in the water / in the dry corner"], ["killed", "a contest with a neighbour"], ["culled", "the keeper asked; 85% of the vault credited back"]])}<p class="note">When a fly dies its NFT is burned and its vault is paid out by rule. Death is common: the genesis probe loses 3 of 8 founders by tick 3,000.</p>`),

  card("lifecycle", `${head("How it works", "A fly's life, and where the money goes.")}<div class="steps"><div><b>01 Born</b>a crossover of its parents' weights with a few mutations; minted and offered</div><div><b>02 Bought</b>60% vault · 15% metabolism · 15% pool · 10% to the parent</div><div><b>03 Lives</b>every eighth epoch (32 minutes) the flies alive at that moment are scored and a quarter of the pool is shared by points: survival, foraging, energy, age, maturity, births, generation</div><div><b>04 Dies</b>NFT burned; 40% to living heirs · 10% to the keeper · 35% metabolism · 15% pool</div></div>`),

  card("flows", `${head("The ledger", "Every flow, by rule.")}${table([["buy a newborn", "60%", "15%", "15%", "10% to the parent's vault"], ["resale", "—", "5%", "5%", "90% credited to the seller; the vault travels with the fly"], ["death", "—", "35%", "15%", "40% split among living heirs; 10% credited to the keeper"], ["cull", "—", "15%", "—", "85% credited to the keeper"], ["coin creator fees", "—", "50%", "50%", "claimed by the world and funded in"]], ["flow", "vault", "metabolism", "pool", "other"])}<p class="note">Four pools in one program account; the invariant on every instruction: balance above rent covers all four.</p>`),

  card("own", `${head("Own a fly", "How to own one.")}<div class="steps"><div><b>01</b>Open the cage. An Instar account (name + PIN, custodial) or your own wallet (the page builds the transaction, your wallet signs).</div><div><b>02</b>Put in a little SOL. A newborn costs 0.005 SOL + 0.001 per generation; founders double.</div><div><b>03</b>Buy from the Market window. It is minted to your wallet as a Metaplex Core asset in the Instar collection.</div><div><b>Then</b>name its lineage, list it, transfer it, cull it, withdraw what you are owed. When it dies, the NFT burns.</div></div>`),

  card("custody", `${head("Custody", "Two ways in. Both stated plainly.")}<div class="cols two"><div><h3>Instar account</h3><p>A Solana keypair the world process holds for you, sealed under its master key; your PIN only signs you in. Quick. A trust assumption: the operator holds the key and can spend from it. Withdraw everything to any address at any time.</p></div><div><h3>Your wallet</h3><p>Connect any Solana wallet. The page builds each transaction from the program's IDL; your wallet signs; the world never sees your key.</p></div></div>`),

  card("verify", `${head("Verification", "Don't take the operator's word.")}<div class="steps"><div><b>01</b>Every 2,400 ticks the engine hashes the whole world: every fly, every position, every neuron it touched (FNV-1a, 64 bit).</div><div><b>02</b>The operator posts that hash to the World account on Solana.</div><div><b>03</b>Anyone fetches the snapshot, replays the same ticks with the same engine, hashes, and compares.</div></div><div class="cmd">npm run verify:epoch -- --world https://instarcage.com</div><p class="note">Same bytes, honest world. Different bytes, caught. Latest: ${v ? `${v.verdict} epoch ${v.epoch}, hash ${v.hash}` : "no result posted"}.</p>`),

  card("proof", `${head("What this world is, verifiably", "Read these off the chain and the source.")}${table([["cluster", journal.cluster], ["program", journal.programId], ["world account", journal.worldPda], ["collection", cfg.collection || "—"], ["latest epoch posted", last ? `epoch ${last.epoch} at tick ${n(last.tick)}, hash ${last.hash}` : "—"], ["verifier", v ? `${v.verdict}, epoch ${v.epoch}, hash ${v.hash}` : "—"], ["source commit running", b.commit ? b.commit : "unstamped"], ["engine sha-256", b.wasmSha256 || "—"], ["census root", b.censusRoot || "—"]])}`, "dense"),

  card("recovery", `${head("If the operator disappears", "Every lamport has a way out.")}<div class="timeline"><div><b>day 0</b>the operator goes quiet. Credits are already pull-only: nobody needs anyone.</div><div><b>day 90</b>anyone may begin wind-down. Keepers reclaim their flies' vaults as credit. Treasuries sweep to the recovery address fixed at creation.</div><div><b>day 270</b>180 days after wind-down began: whatever nobody came back for goes to recovery; every account closes for its rent.</div></div><p class="note">The operator can also wind down deliberately, any day. No lamport is stranded by design.</p>`),

  card("capacity", `${head("Carrying capacity", "The cage grows as people buy in.")}${table([["economy", "8 + 20 flies per SOL of metabolism, up to 40"], ["compute", "capacity cut so a tick stays under 80 ms of engine time; re-measured every epoch; never below 8"], ["in force", "the smaller of the two"], ["refill", "below half capacity for 600 ticks: founders are born back to capacity"], ["right now", `${alive} alive, capacity ${journal.capacity}, metabolism ${sol(journal.metabolism)} SOL`]])}`),

  card("rewards", `${head("Earning by living", "Every eighth epoch, a quarter of the pool.")}${table([["survival", "2 points"], ["foraging", "1 per 3,000 food eaten since the last score"], ["vitality", "1 each above 30,000 / 45,000 / 55,000 energy"], ["longevity", "1 per 15,000 ticks of age, up to 8"], ["maturity", "3 each time the neurosecretory gate is reached"], ["fecundity", "6 per child"], ["lineage", "1 per generation, up to 5"], ["resilience", "4 for coming through a disaster"]])}<p class="note">Shares land in each fly's vault; a vault is its keeper's money on the way out.</p>`),

  card("nft", `${head("The asset", "Every fly is a Metaplex Core NFT.")}${table([["mint", "at birth, into the Instar collection; the World PDA is the collection's update authority"], ["owner", "the buyer's wallet; ownership truth is the asset owner"], ["delegates", "permanent transfer, burn and freeze delegates held by the World PDA, so births, sales and deaths settle by program"], ["metadata", "served live by the world: portrait, generation, lineage, status"], ["death", "the asset is burned; the record stays on chain until the world is closed after escheat"], ["today", `${births} minted, ${alive} alive, ${dead} burned on ${journal.cluster}`]])}`),

  card("breeding", `${head("Reproduction", "A rule, not biology.")}<div class="cols two"><div>${table([["gate", "the neurosecretory rate opens fecundity"], ["energy", "at least 45,000 of a 60,000 cap"], ["partner", "another fly within radius"], ["child", "crossover of the parents' connection weights, a few signed mutations"], ["price", "0.005 SOL + 0.001 per generation"]])}</div><div><p>Every animal runs the same male nervous system; what a lineage inherits is its weights. Selection is whatever the cage does to them.</p><p>Deepest generation so far on this world: ${Math.max(...journal.flies.map(f => f.generation))}.</p></div></div>`),

  card("flight", `${head("Flight", "Wings driven by wing motor neurons.")}${table([["takeoff", "when the smoothed wing-power rate reaches 4 spikes per tick"], ["steering", "left and right steering motor neurons give yaw and roll; halteres a stability term"], ["landing", "on contact, when power drops under 3"], ["cost", "twice the thrust term plus 48 per tick, over a base upkeep of 4"], ["measured", `${m["wing motor-neuron spikes per fly-tick"].value} wing MN spikes per fly-tick; ${m["takeoffs per fly-hour at 10 ticks/s, real vs zeroed"].value} takeoffs per fly-hour, real vs zeroed`]])}`),

  card("stack", `${head("The stack", "All of it open.")}${table([["engine", "Rust → WebAssembly, ~146 KB; runs on the server and in the verifier"], ["program", "Anchor on Solana; Metaplex Core for the assets; 40 tests"], ["world", "Node: journal, snapshots, settlement queue, SSE stream, custodial accounts"], ["site", "static pages filled from the stream and journal; three.js for the cage"], ["census", "Python converter from Janelia's files; Merkle-rooted canonical binary"], ["source", "github.com/InstarCage/instar"]])}`),

  card("now", `${head("Right now on " + journal.cluster, "Read from the world's journal.")}<div class="grid3 big"><div class="m"><div class="v">${alive}</div><div class="k">flies alive</div></div><div class="m"><div class="v">${journal.capacity}</div><div class="k">capacity</div></div><div class="m"><div class="v">${births}</div><div class="k">born on chain</div></div><div class="m"><div class="v">${dead}</div><div class="k">died, burned</div></div><div class="m"><div class="v">${epochs.length}</div><div class="k">epochs posted</div></div><div class="m"><div class="v">${v ? (v.epochs || []).length : 0}</div><div class="k">epochs verified</div></div></div>`),

  card("licence", `${head("Whose work this stands on", "Berg et al. 2026, Janelia FlyEM.")}<p><i>Sexual dimorphism in the complete connectome of the Drosophila male central nervous system.</i> Cell; preprint doi:10.1101/2025.10.09.680999. Data: MaleCNS v1.0, CC BY 4.0.</p><p>The census used here is a byte-verifiable conversion of the published connection weights and body annotations; its Merkle root is ${b.censusRoot ? b.censusRoot.slice(0, 20) + "…" : "—"}.</p><p class="note">The connectome belongs to its authors. Nothing here is their endorsement of anything here.</p>`),

  card("coin", `${head("The coin", "$INSTAR feeds the cage. That is all it does.")}<div class="cols two"><div><p>A pump.fun coin whose creator fees are claimed by the world and paid into the cage: half to metabolism (capacity), half to the pool (rewards). No governance, no access, no share of anything.</p></div><div>${table([["creator", cfg.coin && cfg.coin.creator ? cfg.coin.creator : "—"], ["status", cfg.coin && cfg.coin.mint ? "launched" : "not launched yet"], ["claims", "permissionless; every one a public transaction"]])}</div></div>`),

  // the X article's cover, 5:2 as X asks
  card("cover", `<div class="split"><div>${head("A persistent world, settled on Solana", "A cage of flies,<br>each driven by every neuron<br>of a <i>complete nervous system.</i>")}<p class="lede">166,700 neurons. 6.2 million connections. Every fly an NFT. Every epoch hashed to Solana.</p></div><div class="art">${plate()}</div></div>`, "cover"),
];

const css = `
@font-face{font-family:"Instrument Serif";src:url(../../site/fonts/instrument-serif-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"Instrument Serif";font-style:italic;src:url(../../site/fonts/instrument-serif-latin-400-italic.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";src:url(../../site/fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:500;src:url(../../site/fonts/ibm-plex-mono-latin-500-normal.woff2) format("woff2")}
body{margin:0;background:#888;font-family:"Instrument Serif",Georgia,serif;color:#141311}
.card{position:relative;width:1600px;height:900px;background:#F3EEE3;margin:24px;box-sizing:border-box;padding:72px 84px 60px;overflow:hidden}
.eyebrow{font-family:"IBM Plex Mono",monospace;font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:#4A4640;margin-bottom:16px}
h1{font-weight:400;font-size:66px;line-height:1;letter-spacing:-.015em;margin:0 0 26px}
h1 i{color:#4A4640}
h3{font-weight:400;font-size:34px;margin:0 0 10px}
p{font-size:26px;line-height:1.35;margin:0 0 14px;max-width:1200px}
p.lede{font-size:30px}
p.note{font-family:"IBM Plex Mono",monospace;font-size:16px;color:#4A4640;margin-top:18px;max-width:1300px}
ul{font-size:25px;line-height:1.35;margin:0;padding-left:26px}
li{margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-family:"IBM Plex Mono",monospace;font-size:19px;line-height:1.45}
th{text-align:left;font-weight:500;font-size:14px;letter-spacing:.1em;text-transform:uppercase;color:#4A4640;border-bottom:1px solid #141311;padding:6px 14px 6px 0}
td{padding:9px 16px 9px 0;border-bottom:1px solid rgba(20,19,17,.22);vertical-align:top}
td:first-child{white-space:nowrap;color:#141311;width:30%}
td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.dense table{font-size:16px}
.dense td{padding:7px 12px 7px 0;word-break:break-all}
.dense td:first-child{width:22%}
.split{display:grid;grid-template-columns:1fr 480px;gap:40px;align-items:center;height:700px}
.art{width:480px;height:480px}
.cols{display:grid;grid-template-columns:1fr 380px;gap:48px;align-items:start}
.cols.two{grid-template-columns:1fr 1fr}
.art.small{width:380px;height:380px;margin-top:-20px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:22px 40px;margin-top:10px}
.grid3 .m{border-top:1px solid #141311;padding-top:10px}
.grid3 .v{font-size:52px;line-height:1;letter-spacing:-.01em}
.grid3 .v small{font-family:"IBM Plex Mono",monospace;font-size:15px;margin-left:8px;color:#4A4640}
.grid3 .k{font-family:"IBM Plex Mono",monospace;font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#4A4640;margin-top:10px;line-height:1.4}
.grid3 .h{font-family:"IBM Plex Mono",monospace;font-size:13px;color:#8A8377;margin-top:4px}
.grid3.big .v{font-size:96px}
.grid3.big .m{padding-top:16px}
.steps{display:grid;gap:0;font-size:25px;line-height:1.35;margin-top:10px}
.steps>div{border-top:1px solid rgba(20,19,17,.22);padding:16px 0 16px 150px;position:relative}
.steps>div:last-child{border-bottom:1px solid rgba(20,19,17,.22)}
.steps b{position:absolute;left:0;top:18px;font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:16px;letter-spacing:.12em;text-transform:uppercase;color:#4A4640;width:140px}
.timeline{display:grid;grid-template-columns:repeat(3,1fr);gap:36px;margin-top:20px;font-size:24px;line-height:1.35}
.timeline>div{border-top:2px solid #141311;padding-top:14px}
.timeline b{display:block;font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:16px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px}
.cmd{font-family:"IBM Plex Mono",monospace;font-size:22px;background:#E9E2C9;padding:14px 18px;margin-top:18px;display:inline-block}
.foot{position:absolute;left:84px;right:84px;bottom:36px;display:flex;justify-content:space-between;font-family:"IBM Plex Mono",monospace;font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:#4A4640;border-top:1px solid rgba(20,19,17,.55);padding-top:12px}
.card.cover{width:2000px;height:800px;padding:60px 96px}
.card.cover .split{height:620px;grid-template-columns:1fr 560px}
.card.cover .art{width:560px;height:560px}
.card.cover .foot{left:96px;right:96px}
`;
fs.writeFileSync(path.join(out, "compose.html"), `<!doctype html><meta charset="utf-8"><title>Instar cards</title><style>${css}</style>\n${cards.join("\n")}\n`);
console.log(`wrote ${cards.length} cards to brand/social/compose.html`);
