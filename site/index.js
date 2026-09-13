// index.html: the monograph. Draws the live cage from the world's stream,
// embeds the brain panel, and fills every number from the census header,
// the world's config, or its journal.
import { boot, fetchJournal, verifierLine, fillConstants, CENSUS_HEADER_URL, API } from "./engine.js";
import { Stream } from "./stream.js";
import { Cage3D } from "./cage3d.js";
import { mountBrainPanel, roleRows } from "./brainmap.js";
import { explorerLink, sol, price, short, esc, fmt, STATUS, STATUS_NAME } from "./api.js";

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = String(v); };
const link = (kind, value, src, n = 8) => value ? `<a class="chain" href="${esc(explorerLink(kind, value, src))}" target="_blank" rel="noopener">${esc(value.length > 2 * n + 1 ? short(value, n) : value)}</a>` : "\u2014";
const SURFACE_NAME = ["the floor", "the west wall", "the east wall", "the north wall", "the south wall", "the lid"];

// The measurements figure is filled from site/measurements.json when the
// build has one; otherwise it stays hidden rather than showing placeholders.
async function loadMeasurements() {
  try {
    const r = await fetch("./measurements.json", { cache: "no-store" });
    if (!r.ok) return;
    const m = await r.json();
    if (!m || !Array.isArray(m.items) || !m.items.length) return;
    const grid = $("measurements");
    grid.innerHTML = m.items.map(it =>
      `<div class="m"><div class="v">${esc(it.value)}${it.unit ? `<small>${esc(it.unit)}</small>` : ""}</div><div class="k">${esc(it.label)}</div><div class="h">${esc(it.horizon || "")}</div></div>`
    ).join("");
    grid.hidden = false;
    if (m.note) { $("measurements-note").textContent = m.note; $("measurements-note").hidden = false; }
  } catch { /* no file: the figure stays hidden */ }
}
async function loadCensusHeader() {
  try {
    const r = await fetch(API + CENSUS_HEADER_URL);
    if (!r.ok) return;
    const c = await r.json();
    setText("lc-id", c.dataset.id);
    setText("lc-root", c.merkle.root_sha256);
  } catch { /* the header stays blank */ }
}

(async function main() {
  setText("st-verify", "booting");
  const { journal, config } = await boot({ status: (s) => setText("st-verify", s) });
  const live = journal;
  loadMeasurements();
  if (!live) {
    $("st-verify").innerHTML = `<b class="bad">NO WORLD</b> ${esc(API ? "nothing answers at " + API : "this page must be served by the world process")}`;
    setText("st-cluster", "none");
    setText("ab-mode", "found no world to draw; nothing here is live");
    return;
  }
  if (!config.arena) throw new Error("the world did not publish its arena");
  fillConstants(config, live);
  loadCensusHeader();
  $("ab-chain").innerHTML = `${esc(live.cluster)} &middot; program ${link("address", live.programId, live)}`;

  // ---- the cage ----
  const cage = new Cage3D($("cage"), { arena: config.arena, maxPop: config.maxPop || 64, embedded: true, onSelect: (id) => { describe(id); brain.watch(id, (info) => { rasterInfo = info; }); } });
  const stream = new Stream({ onEvent: (ev) => { if (ev.name === "death" && ev.cause) deaths.set(ev.cause, (deaths.get(ev.cause) || 0) + 1); } });
  let flies = [];
  const note = $("cage-note");
  function describe(id) {
    if (id < 0) { note.textContent = "drag to orbit \u00b7 click a fly to read it"; return; }
    const f = cage.flyById(id);
    if (!f) return;
    const rec = (live.flies || []).find(l => l.id === id);
    note.textContent = `#${id} \u00b7 ${f.mode ? `flying at layer ${f.z.toFixed(1)}` : `walking on ${SURFACE_NAME[f.s] || "the cage"}`} \u00b7 energy ${fmt(f.e)}` +
      (rec ? ` \u00b7 gen ${rec.generation} \u00b7 ${STATUS_NAME[rec.status]} \u00b7 vault ${sol(rec.vault)} SOL` : "");
  }
  const deaths = new Map();

  // ---- the brain ----
  const brain = mountBrainPanel({ bars: $("brain-bars"), raster: $("brain-raster"), config });
  let rasterInfo = null;
  setText("b-stride", brain.stride);
  $("role-legend").querySelector("tbody").innerHTML = roleRows(config).map(([r, label, n]) => `<tr><td>${r}</td><td>${esc(label)}</td><td class="n">${fmt(n)}</td></tr>`).join("");
  function renderBrain() {
    const id = cage.selected >= 0 ? cage.selected : (flies[0] ? flies[0].id : -1);
    if (id >= 0 && id !== watched) { watched = id; brain.watch(id, (info) => { rasterInfo = info; }); }
    const f = id >= 0 ? cage.flyById(id) : null;
    brain.bars(f ? f.fired : null);
    setText("brain-cap", f
      ? `Fly #${id}, ${f.mode ? "flying" : "walking"}, at the world's tick ${fmt(stream.t)}. Bars: neurons that fired, by role group, over the group's size, log scale. Raster: every ${brain.stride}th neuron in canonical order, ${fmt(brain.sampled)} of ${fmt(brain.nodes)}, one ${brain.dot}\u00d7${brain.dot} dot each, drawn when it fired${rasterInfo ? `; ${fmt(rasterInfo.lit)} of them did` : ""}. The raster is read from the world four times a second, so it lags the cage by up to a quarter second.`
      : "no fly is in the cage right now");
  }
  let watched = -1;

  // ---- the frame loop ----
  let frame = 0, lastT = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    flies = stream.sample(now);
    cage.render(flies, stream.next ? stream.light : 255, dt);
    frame++;
    setText("st-tick", fmt(stream.t || live.tick));
    setText("st-pop", flies.length);
    setText("st-flying", flies.filter(f => f.mode === 1).length);
    setText("st-epoch", fmt(Math.floor((stream.t || live.tick) / live.epochInterval)));
    {
      const v = $("st-verify");
      const vd = verifierLine(live);
      let html;
      if (live.settling === false) html = `<b class="bad">SETTLEMENT PAUSED</b> operator out of gas`;
      else if (stream.state === "lost") html = `<b class="bad">STREAM LOST</b> reconnecting`;
      else if (stream.state === "stalled") html = `<b>STREAM STALLED</b> no frame for 3 s`;
      else if (stream.state === "reconnecting") html = `<b>STREAM DROPPED</b> reconnecting`;
      else if (stream.state !== "live") html = `<b>CONNECTING</b>`;
      else if (vd) html = `<b class="${vd.cls}">${vd.word}</b> ${esc(vd.detail)}`;
      else html = `<b>LIVE</b> unverified: no verifier result posted`;
      if (v.innerHTML !== html) v.innerHTML = html;
    }
    if (frame % 30 === 1) {
      if (cage.selected >= 0) describe(cage.selected);
      updateCageNow();
      renderBrain();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function updateCageNow() {
    document.querySelectorAll("#death-table tr[data-c]").forEach(tr => { tr.lastElementChild.textContent = fmt(deaths.get(tr.dataset.c) || 0); });
    if (!stream.next) return;
    const light = stream.light, temp = stream.temp / 100;
    const flying = flies.filter(f => f.mode === 1).length;
    $("cage-now").innerHTML =
      `light ${light}/255 (${light > 128 ? "day" : "night"})<br>temperature ${temp.toFixed(2)} &deg;C at the centre<br>` +
      `alive ${flies.length} &middot; flying ${flying} &middot; capacity ${live.capacity}<br>` +
      `on the walls or the lid ${flies.filter(f => f.mode === 0 && f.s > 0).length} &middot; proboscis out ${flies.filter(f => f.pr > 0.5).length}`;
  }

  // ---- everything from the journal ----
  function renderJournal() {
    setText("st-cluster", live.cluster);
    setText("rc-cluster", live.cluster);
    $("rc-program").innerHTML = link("address", live.programId, live, 44);
    $("rc-world").innerHTML = link("address", live.worldPda, live, 44);
    $("rc-operator").innerHTML = link("address", live.operator, live, 44);
    setText("rc-seed", live.seed);
    const vd = verifierLine(live);
    $("rc-verified").innerHTML = vd
      ? `<span class="${vd.cls === "ok" ? "chain-c" : "bad"}">${vd.word}</span> ${esc(vd.detail)}; epoch ${vd.epoch}, hash ${esc(vd.hash)}`
      : `<span class="faint">no result posted</span>`;
    setText("ec-metab", sol(live.metabolism) + " SOL");
    setText("ec-pool", sol(live.pool) + " SOL");
    setText("ec-cap", live.capacity);
    setText("ec-alive", (live.flies || []).filter(l => l.status !== STATUS.DEAD).length);
    setText("ec-opbal", sol(live.operatorBalance) + " SOL");
    setText("ec-settling", live.settling === false ? "paused: operator out of gas" : `running${live.pendingOps ? `, ${live.pendingOps} pending` : ""}`);
    const offers = (live.flies || []).filter(l => l.status === STATUS.OFFERED).slice(0, 8);
    $("offers-table").querySelector("tbody").innerHTML = offers.length
      ? offers.map(l => `<tr><td>#${l.id}</td><td>gen ${l.generation}</td><td class="n">${price(l.salePrice)} SOL</td></tr>`).join("")
      : `<tr><td class="faint">no newborn is offered right now; the next birth will be</td></tr>`;
    const eps = [...(live.epochs || [])].slice(-12).reverse();
    const v = live.verifier;
    $("epoch-table").querySelector("tbody").innerHTML = eps.length
      ? eps.map(ep => {
        const checked = v && v.epoch === ep.epoch;
        const state = checked ? (v.verdict === "VERIFIED" ? "verified" : "MISMATCH") : "posted";
        const cls = state === "verified" ? "chain-c" : state === "MISMATCH" ? "bad" : "faint";
        return `<tr><td class="n">${ep.epoch}</td><td class="n">${fmt(ep.tick)}</td><td class="sig">${esc(ep.hash)}</td><td class="${cls}">${state}</td><td>${link("tx", ep.sig, live)}</td></tr>`;
      }).join("")
      : `<tr><td colspan="5" class="faint">no epoch has been posted yet</td></tr>`;
    const txs = [...(live.txlog || [])].slice(-12).reverse();
    $("tx-table").querySelector("tbody").innerHTML = txs.length
      ? txs.map(t => `<tr><td>${new Date(t.t).toISOString().replace("T", " ").slice(0, 19)}</td><td>${esc(t.kind)}${t.ok === false ? ' <span class="bad">failed</span>' : ""}</td><td class="n">${t.id ?? ""}</td><td>${link("tx", t.sig, live)}</td></tr>`).join("")
      : `<tr><td colspan="4" class="faint">no transaction yet</td></tr>`;
  }
  renderJournal();
  setInterval(async () => {
    const j = await fetchJournal(8000);
    if (!j) return;
    Object.assign(live, j);
    renderJournal();
  }, 4000);
  // headless verification: drive one frame without rAF
  window.__instar = { cage, stream, brain, config, journal: live, frame: () => { flies = stream.sample(performance.now()); cage.render(flies, stream.light, 1 / 60); } };
})().catch(e => {
  const v = document.getElementById("st-verify");
  if (v) v.innerHTML = `<b class="bad">FAILED</b> ${esc(e.message)}`;
  console.error(e);
});
