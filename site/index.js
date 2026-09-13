// index.html: the monograph. Boots the engine, embeds the live dish, fills every
// number from the census file, the engine, or the world's journal.
import { boot, pollJournal, verdict, fillConstants } from "./engine.js";
import { Dish3D } from "./dish3d.js";
import { mountBrainMap } from "./brainmap.js";
import { explorerLink, sol, price, short, esc, fmt, STATUS, STATUS_NAME } from "./api.js";

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = String(v); };
const link = (kind, value, src, n = 8) => value ? `<a class="chain" href="${explorerLink(kind, value, src)}" target="_blank" rel="noopener">${esc(value.length > 2 * n + 1 ? short(value, n) : value)}</a>` : "\u2014";

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

(async function main() {
  setText("st-verify", "booting");
  const world = await boot({ status: (s) => setText("st-verify", s) });
  const { census, sim } = world;
  const live = world.live;

  // ---- abstract: counted, not typed ----
  fillConstants(world);
  setText("lc-id", census.dataset.id);
  setText("lc-root", census.merkle.root_sha256);
  if (live) {
    $("ab-chain").innerHTML = `${esc(live.cluster)} &middot; program ${link("address", live.programId, live)}`;
    setText("ab-mode", world.joinedAt
      ? `joined the world at tick ${fmt(world.joinedAt)} from its snapshot and verifies every epoch from there`
      : "replays the world's journal from genesis and verifies every epoch hash");
  } else {
    setText("ab-mode", "runs a local sandbox from a fresh genesis; no chain, no market, nothing recorded");
  }

  // ---- the dish ----
  const canvas = $("dish");
  const dish = new Dish3D(canvas, world, { embedded: true, onSelect: (slot) => describeSlot(slot) });
  const note = $("dish-note");
  function describeSlot(slot) {
    if (slot < 0) { note.textContent = "drag to orbit \u00b7 click a larva to read it"; return; }
    const uid = world.uids()[slot], gen = world.generations()[slot], en = world.energy()[slot], age = world.ages()[slot];
    const rec = live && live.larvae ? live.larvae.find(l => l.id === uid) : null;
    note.textContent = `#${uid} \u00b7 gen ${gen} \u00b7 energy ${fmt(en)} \u00b7 age ${fmt(age)}` +
      (rec ? ` \u00b7 ${STATUS_NAME[rec.status]} \u00b7 vault ${sol(rec.vault)} SOL` : "");
  }
  const deaths = new Map();
  world.onEvent((ev) => { if (ev.kind === 2) deaths.set(ev.b, (deaths.get(ev.b) || 0) + 1); });

  // ---- the brain ----
  const brain = mountBrainMap({
    canvas: $("brainmap"), census, roles: world.roles,
    legend: $("role-legend").querySelector("tbody"), tip: $("brain-tip"), tools: $("brain-tools"),
    edgesEl: document.querySelector("#brain .fig-cap [data-edges]"),
  });

  loadMeasurements();

  // ---- static-per-frame counters ----
  let frame = 0, lastT = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const behind = world.pace(now);
    dish.render(dt);
    frame++;
    setText("st-tick", fmt(world.tick()));
    setText("st-pop", sim.pop_count());
    setText("st-epoch", fmt(world.epoch()));
    if (live) {
      const v = $("st-verify");
      const vd = verdict(live);
      let html;
      if (live.settling === false) html = `<b class="bad">SETTLEMENT PAUSED</b> operator out of gas`;
      else if (behind > 2000) html = `<b>SYNCING</b> ${fmt(behind)} ticks behind`;
      else if (vd) html = `<b class="${vd.cls}">${vd.word}</b> ${esc(vd.detail)}`;
      else html = `<b>LIVE</b> awaiting the next epoch boundary`;
      if (v.innerHTML !== html) v.innerHTML = html;
    } else {
      setText("st-cluster", "none (sandbox)");
      const v = $("st-verify");
      const html = `<b>SANDBOX</b> no world reachable`;
      if (v.innerHTML !== html) v.innerHTML = html;
    }
    if (frame % 30 === 1) {
      if (dish.selected >= 0) describeSlot(dish.selected);
      updateDishNow();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function updateDishNow() {
    const biome = world.biome();
    const counts = new Int32Array(8);
    for (let i = 0; i < biome.length; i++) counts[biome[i]]++;
    document.querySelectorAll("#biome-table tr[data-b]").forEach(tr => { tr.lastElementChild.textContent = fmt(counts[+tr.dataset.b]); });
    document.querySelectorAll("#death-table tr[data-c]").forEach(tr => { tr.lastElementChild.textContent = fmt(deaths.get(+tr.dataset.c) || 0); });
    const light = sim.light_now(), temp = sim.temp_now() / 100;
    $("dish-now").innerHTML =
      `light ${light}/255 (${light > 128 ? "day" : "night"})<br>temperature ${temp.toFixed(2)} &deg;C<br>` +
      `alive ${sim.pop_count()} &middot; capacity ${world.capacity()}<br>` +
      `births ${fmt(sim.births_total())} &middot; deaths ${fmt(sim.deaths_total())} &middot; kills ${fmt(sim.kills_total())}<br>` +
      `max generation ${sim.max_generation()}`;
  }

  // ---- everything from the journal ----
  function renderJournal() {
    if (!live) return;
    setText("st-cluster", live.cluster);
    setText("rc-cluster", live.cluster);
    $("rc-program").innerHTML = link("address", live.programId, live, 44);
    $("rc-world").innerHTML = link("address", live.worldPda, live, 44);
    $("rc-operator").innerHTML = link("address", live.operator, live, 44);
    setText("rc-seed", live.seed);
    setText("rc-verified", `${live.verified} verified on chain, ${live.journalOnly} match the journal only, ${live.mismatched} diverged, ${live.lastCheckedEpoch} checked`);
    const c = live.chain;
    $("rc-chain").innerHTML = !c ? "not read yet"
      : c.error ? `<span class="bad">unread</span>: ${esc(c.error)}`
      : `epoch ${c.epoch} at tick ${fmt(c.tick)} \u00b7 last_state_hash ${esc(c.hash32)}`;
    setText("ec-metab", sol(live.metabolism) + " SOL");
    setText("ec-pool", sol(live.pool) + " SOL");
    setText("ec-cap", live.capacity);
    setText("ec-alive", (live.larvae || []).filter(l => l.status !== STATUS.DEAD).length);
    setText("ec-opbal", sol(live.operatorBalance) + " SOL");
    setText("ec-settling", live.settling === false ? "paused: operator out of gas" : `running${live.pendingOps ? `, ${live.pendingOps} pending` : ""}`);
    const offers = (live.larvae || []).filter(l => l.status === STATUS.OFFERED).slice(0, 8);
    $("offers-table").querySelector("tbody").innerHTML = offers.length
      ? offers.map(l => `<tr><td>#${l.id}</td><td>gen ${l.generation}</td><td class="n">${price(l.salePrice)} SOL</td></tr>`).join("")
      : `<tr><td class="faint">no newborn is offered right now; the next birth will be</td></tr>`;
    const eps = [...(live.epochs || [])].slice(-12).reverse();
    $("epoch-table").querySelector("tbody").innerHTML = eps.length
      ? eps.map(ep => {
        const st = live.epochState.get(ep.epoch);
        const state = !st ? (ep.tick > world.tick() ? "pending" : "before join")
          : st.chain === true ? "verified" : st.chain === false || !st.journal ? "DIVERGED" : "matches journal";
        const cls = state === "verified" ? "chain-c" : state === "DIVERGED" ? "bad" : "faint";
        return `<tr><td class="n">${ep.epoch}</td><td class="n">${fmt(ep.tick)}</td><td class="sig">${esc(ep.hash)}</td><td class="${cls}">${state}</td><td>${link("tx", ep.sig, live)}</td></tr>`;
      }).join("")
      : `<tr><td colspan="5" class="faint">no epoch has been posted yet</td></tr>`;
    const txs = [...(live.txlog || [])].slice(-12).reverse();
    $("tx-table").querySelector("tbody").innerHTML = txs.length
      ? txs.map(t => `<tr><td>${new Date(t.t).toISOString().replace("T", " ").slice(0, 19)}</td><td>${esc(t.kind)}${t.ok === false ? ' <span class="bad">failed</span>' : ""}</td><td class="n">${t.id ?? ""}</td><td>${link("tx", t.sig, live)}</td></tr>`).join("")
      : `<tr><td colspan="4" class="faint">no transaction yet</td></tr>`;
  }
  renderJournal();
  if (live) {
    setInterval(async () => {
      const j = await pollJournal(world);
      if (j && j.desynced) { location.reload(); return; }
      renderJournal();
    }, 4000);
  }
  // headless verification: drive one frame without rAF
  window.__instar = { world, dish, brain, frame: () => { world.pace(performance.now()); dish.render(1 / 60); } };
})().catch(e => {
  const v = document.getElementById("st-verify");
  if (v) v.innerHTML = `<b class="bad">FAILED</b> ${esc(e.message)}`;
  console.error(e);
});
