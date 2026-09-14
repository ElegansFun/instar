// index.html: the front page. Draws the live cage from the world's stream
// and fills every number from the world's config and journal; nothing here
// is typed in.
import { boot, fetchJournal, verifierLine, fillConstants, API } from "./engine.js";
import { Stream } from "./stream.js";
import { Cage3D } from "./cage3d.js";
import { explorerLink, sol, price, short, esc, fmt, STATUS, STATUS_NAME } from "./api.js";

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = String(v); };
const setHtml = (id, html) => { const el = $(id); if (el && el.innerHTML !== html) el.innerHTML = html; };
const link = (kind, value, src, n = 8) => value ? `<a class="chain" href="${esc(explorerLink(kind, value, src))}" target="_blank" rel="noopener">${esc(value.length > 2 * n + 1 ? short(value, n) : value)}</a>` : "\u2014";
const SURFACE_NAME = ["the floor", "the west wall", "the east wall", "the north wall", "the south wall", "the lid"];

(async function main() {
  setText("st-verify", "booting");
  setHtml("lv-state", "<b>reading the world</b>");
  const { journal, config } = await boot({ status: (s) => setText("st-verify", s) });
  const live = journal;
  if (!live) {
    const why = esc(API ? "nothing answers at " + API : "this page must be served by the world process");
    setHtml("st-verify", `<b class="bad">NO WORLD</b> ${why}`);
    setHtml("lv-state", `<b class="bad">NO WORLD</b> ${why}`);
    setText("st-cluster", "none");
    // a world that is down comes back; a deploy is the likeliest reason
    setTimeout(main, 5000);
    return;
  }
  fillConstants(config, live);
  setText("vf-url", location.origin);

  // ---- the cage ----
  // without the arena the page still reads the journal; only the drawing is skipped
  const cage = config.arena ? new Cage3D($("cage"), { arena: config.arena, maxPop: config.maxPop || 64, embedded: true, onSelect: describe }) : null;
  if (!cage) $("cage-note").textContent = "the world did not publish its arena; the cage is not drawn";
  const stream = new Stream({});
  let flies = [];
  const note = $("cage-note");
  function describe(id) {
    if (id < 0) { note.textContent = "drag to orbit \u00b7 click a fly to read it"; return; }
    const f = cage && cage.flyById(id);
    if (!f) return;
    const rec = (live.flies || []).find(l => l.id === id);
    note.textContent = `#${id} \u00b7 ${f.mode ? `flying at layer ${f.z.toFixed(1)}` : `walking on ${SURFACE_NAME[f.s] || "the cage"}`} \u00b7 energy ${fmt(f.e)}` +
      (rec ? ` \u00b7 gen ${rec.generation} \u00b7 ${STATUS_NAME[rec.status]} \u00b7 vault ${sol(rec.vault)} SOL` : "");
  }

  let frame = 0, lastT = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    flies = stream.sample(now);
    if (cage) cage.render(flies, stream.next ? stream.light : 255, dt);
    frame++;
    const t = stream.t || live.tick;
    setText("st-tick", fmt(t));
    // before the stream's first frame the journal's count is the honest one
    const streaming = stream.state === "live" && stream.frames > 0;
    const pop = streaming ? flies.length : (live.flies || []).filter(l => l.status !== STATUS.DEAD).length;
    setText("st-pop", pop);
    setText("st-flying", streaming ? flies.filter(f => f.mode === 1).length : "\u2014");
    setText("lv-pop", pop);
    setText("lv-tick", fmt(t));
    setText("lv-epoch", fmt(Math.floor(t / live.epochInterval)));
    {
      const vd = verifierLine(live);
      let html;
      if (live.settling === false) html = `<b class="bad">SETTLEMENT PAUSED</b> operator out of gas`;
      else if (stream.state === "lost") html = `<b class="bad">STREAM LOST</b> reconnecting`;
      else if (stream.state === "stalled") html = `<b>STREAM STALLED</b> no frame for 3 s`;
      else if (stream.state === "reconnecting") html = `<b>STREAM DROPPED</b> reconnecting`;
      else if (stream.state !== "live") html = `<b>CONNECTING</b>`;
      else if (vd) html = `<b class="${vd.cls}">${vd.word}</b> ${esc(vd.short)}`;
      else html = `<b>LIVE</b> unverified: no verifier result posted`;
      setHtml("st-verify", html);
      setHtml("lv-state", html);
    }
    if (cage && frame % 30 === 1 && cage.selected >= 0) describe(cage.selected);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---- everything from the journal ----
  function renderJournal() {
    setText("st-cluster", live.cluster);
    setText("lv-cap", live.capacity);
    setHtml("lv-chain", `${esc(live.cluster)} \u00b7 program ${link("address", live.programId, live)} \u00b7 world ${link("address", live.worldPda, live)}`);
    setText("ec-metab", sol(live.metabolism) + " SOL");
    setText("ec-pool", sol(live.pool) + " SOL");
    setText("ec-cap", live.capacity);
    setText("ec-alive", (live.flies || []).filter(l => l.status !== STATUS.DEAD).length);
    setText("ec-settling", live.settling === false ? "paused: operator out of gas" : `running${live.pendingOps ? `, ${live.pendingOps} pending` : ""}`);
    const offers = (live.flies || []).filter(l => l.status === STATUS.OFFERED).sort((a, b) => (BigInt(a.salePrice) < BigInt(b.salePrice) ? -1 : BigInt(a.salePrice) > BigInt(b.salePrice) ? 1 : a.id - b.id));
    setHtml("offers-table", `<tbody>${offers.length
      ? offers.slice(0, 8).map(l => `<tr><td><a href="./cage.html#fly=${l.id}">#${l.id}</a></td><td>gen ${l.generation}</td><td class="n">${price(l.salePrice)} SOL</td></tr>`).join("")
      : `<tr><td class="faint">no newborn is offered right now; the next birth will be</td></tr>`}</tbody>`);
    const cheapest = offers[0] || null;
    const eco = config.economy;
    const rule = eco ? `${sol(eco.offerBase)} SOL plus ${sol(eco.offerPerGen)} per generation` : "";
    setText("own-price", cheapest ? `${price(cheapest.salePrice)} SOL right now (${rule})` : rule || "\u2014");
    // the deposit address on devnet takes test SOL only; real SOL sent there is lost to the world
    const oc = document.getElementById("own-cluster");
    if (oc) { oc.hidden = live.cluster === "mainnet-beta"; oc.textContent = `This world runs on ${live.cluster}: the SOL is test SOL, free from the Airdrop button in the cage's Account window. Do not send real SOL to a devnet address.`; }
    // how long a fly lives here, from the record rather than a guess
    const dead = (live.flies || []).filter(l => l.status === STATUS.DEAD && l.deathTick > l.birthTick).map(l => l.deathTick - l.birthTick).sort((a, b) => a - b);
    const lifetime = dead.length ? `; the median fly in this world so far lived ${Math.round(dead[dead.length >> 1] / live.tickrate / 60)} minutes (${dead.length} deaths)` : "";
    for (const id of ["own-lifetime", "faq-lifetime"]) setText(id, lifetime);
    const vd = verifierLine(live);
    setHtml("rc-verified", vd
      ? `<span class="${vd.cls === "ok" ? "chain-c" : "bad"}">${vd.word}</span> ${esc(vd.detail)}; epoch ${vd.epoch}, hash ${esc(vd.hash)}`
      : `<span class="faint">no result posted yet</span>`);
    setHtml("rc-program", link("address", live.programId, live, 44));
    setHtml("rc-world", link("address", live.worldPda, live, 44));
    setHtml("rc-collection", config.collection ? link("address", config.collection, live, 44) : "\u2014");
    const last = (live.epochs || [])[(live.epochs || []).length - 1];
    setHtml("rc-epoch", last ? `epoch ${last.epoch} at tick ${fmt(last.tick)}, hash ${esc(last.hash)}, ${link("tx", last.sig, live)}` : `<span class="faint">none yet</span>`);
    const b = config.build || {};
    setHtml("rc-commit", b.commit
      ? `<a class="chain" href="https://github.com/InstarCage/instar/commit/${esc(b.commit)}" target="_blank" rel="noopener">${esc(b.commit.slice(0, 12))}</a>${b.dirty ? ' <span class="bad">with uncommitted changes</span>' : ""}${b.at ? ` \u00b7 deployed ${esc(b.at.slice(0, 16).replace("T", " "))} UTC` : ""}`
      : `<span class="faint">unstamped build: the commit was not recorded at deploy</span>`);
    setText("rc-wasm", b.wasmSha256 || "\u2014");
    setText("rc-census", b.censusRoot || "\u2014");
    // the coin: named by the world once it exists, so this page needs no redeploy
    const coin = config.coin || {};
    setHtml("coin-mint", coin.mint ? `${link("address", coin.mint, live, 44)} \u00b7 <a class="chain" href="https://pump.fun/coin/${esc(coin.mint)}" target="_blank" rel="noopener">pump.fun</a>` : `<span class="faint">not launched yet</span>`);
    setHtml("coin-creator", coin.creator ? link("address", coin.creator, live, 44) : `<span class="faint">no fee keypair configured</span>`);
    const claims = (live.txlog || []).filter(t => t.kind === "claim-fees" && t.ok !== false);
    const funds = (live.txlog || []).filter(t => t.kind === "fees" && t.ok !== false);
    setHtml("coin-claims", claims.length || funds.length
      ? `${fmt(claims.length)} claim${claims.length === 1 ? "" : "s"} \u00b7 ${fmt(funds.length)} sweep${funds.length === 1 ? "" : "s"} into the cage<br>latest ${funds.length ? link("tx", funds[funds.length - 1].sig, live) : "\u2014"}`
      : "none yet");
  }
  renderJournal();
  setInterval(async () => {
    const j = await fetchJournal(8000);
    if (!j) return;
    Object.assign(live, j);
    renderJournal();
  }, 4000);
  // headless verification: drive one frame without rAF
  window.__instar = { cage, stream, config, journal: live, frame: () => { flies = stream.sample(performance.now()); cage.render(flies, stream.light, 1 / 60); } };
})().catch(e => {
  const v = document.getElementById("st-verify");
  if (v) v.innerHTML = `<b class="bad">FAILED</b> ${esc(e.message)}`;
  console.error(e);
});
