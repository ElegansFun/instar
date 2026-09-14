// The X article, as the editor takes it: brand/social/article.md becomes a
// list of blocks in brand/social/article.json. Paragraphs, headings and
// lists go in as HTML pastes; each `[image: x.png]` is a media block; native
// tables (markdown, the way X's table block is edited) are added under the
// sections that have numbers, read from the world like the cards are; the
// verifier command is a code block. brand/README.md says how the list is
// played into the editor.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, "social");
const cfg = JSON.parse(fs.readFileSync(path.join(out, ".config.json"), "utf8"));
const journal = JSON.parse(fs.readFileSync(path.join(out, ".journal.json"), "utf8"));
const meas = JSON.parse(fs.readFileSync(path.join(dir, "..", "site", "measurements.json"), "utf8"));
const md = fs.readFileSync(path.join(out, "article.md"), "utf8");

const n = (v) => Number(v).toLocaleString("en-US");
const sol = (l) => (Number(l) / 1e9).toFixed(4) + " SOL";
const rc = cfg.roleCounts, groups = cfg.groups;
const gsum = (g) => groups[g].reduce((a, r) => a + (rc[r] || 0), 0);
const alive = journal.flies.filter(f => f.status !== 4).length;
const dead = journal.flies.filter(f => f.status === 4).length;
const last = journal.epochs[journal.epochs.length - 1];
const v = journal.verifier;
const b = cfg.build || {};
const explorer = (kind, id) => `${cfg.explorer}/${kind}/${id}${cfg.explorerQuery || ""}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s)]+[^\s).,;]/g, (u) => `<a href="${u}">${u}</a>`).replace(/\$INSTAR/g, "<b>$INSTAR</b>");
const table = (ths, rows) => ["| " + ths.join(" | ") + " |", "| " + ths.map(() => "---").join(" | ") + " |", ...rows.map(r => "| " + r.map(c => String(c).replace(/\|/g, "\\|")).join(" | ") + " |")].join("\n");

// native tables, keyed by the section heading they follow
const TABLES = {
  "1. The brain is real": table(["role, from Janelia's annotations", "neurons"], [
    ["sensory neurons", n(gsum("sens"))], ["descending neurons (brain to cord)", n(gsum("dn"))], ["ascending neurons (cord to brain)", n(gsum("an"))],
    ["leg motor neurons, left / right", `${n(gsum("legL"))} / ${n(gsum("legR"))}`], ["wing motor neurons, power / steering", `${n(gsum("wingP"))} / ${n(gsum("wingS"))}`],
    ["haltere motor neurons", n(gsum("haltere"))], ["proboscis motor neurons", n(gsum("prob"))], ["neurosecretory neurons", n(gsum("neuro"))],
    ["interneurons, driven by wiring alone", n(rc[0])], ["total", n(cfg.nodes)], ["connections of 5+ synapses", n(cfg.edges)]]),
  "3. The engine": table(["", "rule"], [
    ["neuron model", "threshold unit: fire above 16,384; leak a quarter per tick; refractory 3 ticks; under 1,024 snaps to rest"],
    ["propagation", "event-driven along the census edges; only touched neurons are updated"],
    ["arithmetic", "fixed point 16.16, xorshift64*; no floating point anywhere"],
    ["tick rate", `10 ticks per second; an epoch every ${n(cfg.epochInterval)} ticks`],
    ["cost", `${meas.items.find(i => i.label.startsWith("engine time per fly-tick")).value.split(" ")[0]} ms per fly-tick (${meas.items.find(i => i.label.startsWith("engine time per fly-tick")).horizon})`],
    ["memory", `${meas.items.find(i => i.label.startsWith("engine memory")).value} MB at 40 flies`],
    ["binary", `instar_sim.wasm, ${n(meas.wasm_bytes)} bytes, sha-256 ${b.wasmSha256 || "—"}`]]),
  "4. Measured, not asserted": table(["measurement", "value", "horizon"], meas.items.map(i => [i.label, i.value + (i.unit ? " " + i.unit : ""), i.horizon])),
  "5. The cage": table(["sense", "what the cage writes into it"], [
    ["olfactory", "odour from the food as a field on the floor, thinner with height"], ["gustatory (leg taste, proboscis)", "the substrate under the tarsi and the proboscis"],
    ["Johnston's organ", "own airflow in flight; neighbours' wingbeats within a radius"], ["bristle, chordotonal", "contact, and the fly's own leg motion"],
    ["thermo, hygro", "temperature and humidity gradients at the fly"], ["photoreceptors R1–6, R7/8, ocellar", "an 8×2 luminance sample ahead of each eye, the lamp's colour, light overhead"],
    ["haltere sensory", "the body's angular velocity"], ["interoceptive", "how full the crop is"]]),
  "7. Where the money goes": table(["flow", "vault", "metabolism", "pool", "other"], [
    ["buy a newborn", "60%", "15%", "15%", "10% to the parent's vault"], ["resale", "—", "5%", "5%", "90% credited to the seller; the vault travels with the fly"],
    ["death", "—", "35%", "15%", "40% split among living heirs; 10% credited to the keeper"], ["cull", "—", "15%", "—", "85% credited to the keeper"],
    ["coin creator fees", "—", "50%", "50%", "claimed by the world and funded in"]]),
  "9. Verify it yourself": table(["", "on " + journal.cluster], [
    ["program", `[${journal.programId}](${explorer("address", journal.programId)})`], ["world account", `[${journal.worldPda}](${explorer("address", journal.worldPda)})`],
    ["collection", cfg.collection ? `[${cfg.collection}](${explorer("address", cfg.collection)})` : "—"],
    ["latest epoch posted", last ? `epoch ${last.epoch} at tick ${n(last.tick)}, hash ${last.hash} ([tx](${explorer("tx", last.sig)}))` : "—"],
    ["verifier", v ? `${v.verdict}, epoch ${v.epoch}, hash ${v.hash}; ${(v.epochs || []).length} distinct epochs verified` : "—"],
    ["source commit running", b.commit ? `[${b.commit.slice(0, 12)}](https://github.com/InstarCage/instar/commit/${b.commit})` : "unstamped"],
    ["engine sha-256", b.wasmSha256 || "—"], ["census Merkle root", b.censusRoot || "—"],
    ["right now", `${alive} alive of capacity ${journal.capacity}; ${journal.flies.length} born, ${dead} died; metabolism ${sol(journal.metabolism)}, pool ${sol(journal.pool)}`]]),
  "10. If the operator disappears": table(["day", "what anyone can do"], [
    ["0", "the operator goes quiet; credits are already pull-only, nobody needs anyone"],
    ["90", "anyone may begin wind-down; keepers reclaim their flies' vaults as credit; treasuries sweep to the recovery address fixed at creation"],
    ["180", "whatever nobody came back for goes to recovery; every account closes for its rent"]]),
  "13. The stack, all of it open": table(["part", ""], [
    ["engine", "Rust → WebAssembly, ~146 KB; runs on the server and in the verifier"], ["program", "Anchor on Solana; Metaplex Core for the assets; 40 tests"],
    ["world", "Node: journal, snapshots, settlement queue, SSE stream, custodial accounts"], ["site", "static pages filled from the stream and journal; three.js for the cage"],
    ["census", "Python converter from Janelia's files; Merkle-rooted canonical binary"], ["source", "[github.com/InstarCage/instar](https://github.com/InstarCage/instar), MIT; connectome CC BY 4.0"]]),
};
// the rewards table sits after its card in section 7
const REWARDS = table(["score", "points"], [["survival", "2"], ["foraging", "1 per 3,000 food eaten since the last score"], ["vitality", "1 each above 30,000 / 45,000 / 55,000 energy"],
  ["longevity", "1 per 15,000 ticks of age, up to 8"], ["maturity", "3 each time the neurosecretory gate is reached"], ["fecundity", "6 per child"], ["lineage", "1 per generation, up to 5"], ["resilience", "4 for coming through a disaster"]]);

const ops = [];
let title = "";
let section = "";
for (const block of md.split(/\n\n+/)) {
  const t = block.trim();
  if (!t) continue;
  if (t.startsWith("# ")) { title = t.slice(2); continue; }
  if (t.startsWith("## ")) {
    section = t.slice(3);
    ops.push({ html: `<h2>${esc(section)}</h2>` });
    continue;
  }
  const img = t.match(/^\[image: ([\w.-]+)\]$/);
  if (img) {
    ops.push({ image: img[1] });
    if (img[1] === "rewards.png") ops.push({ table: REWARDS });
    // the section's table follows its first card
    if (TABLES[section]) { ops.push({ table: TABLES[section] }); delete TABLES[section]; }
    continue;
  }
  if (/^INSTAR_URL=/.test(t)) { ops.push({ code: t }); continue; }
  ops.push({ html: `<p>${linkify(t)}</p>` });
}
ops.push({ divider: true });
ops.push({ html: `<p><i>Drosophila melanogaster · Janelia MaleCNS v1.0 (Berg et al. 2026, CC BY 4.0) · Solana ${esc(journal.cluster)}.</i> Numbers on this page were read from the world at tick ${n(journal.tick || last.tick)}.</p>` });

const left = Object.keys(TABLES);
if (left.length) throw new Error("tables not placed: " + left.join(", "));
fs.writeFileSync(path.join(out, "article.json"), JSON.stringify({ title: "Instar: a cage of fruit flies, each driven by a complete connectome, settled on Solana", cover: "cover.png", ops }, null, 1) + "\n");
console.log(`article.json: ${ops.length} blocks (${ops.filter(o => o.image).length} images, ${ops.filter(o => o.table).length} tables)`);
