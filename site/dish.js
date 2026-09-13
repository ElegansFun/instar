// dish.html: the bench. Full-screen dish, HUD, dock windows, inspector,
// account. Everything shown is read from the engine in this tab or from the
// world's journal; the page never invents a number.
import { boot, pollJournal, verdict, fillConstants, DEATH_CAUSE, API, SAME_ORIGIN_API } from "./engine.js";
import { Dish3D } from "./dish3d.js";
import { ROLE_COLOR } from "./brainmap.js";
import { drawQR } from "./qr.js";
import { session, setSession, post, explorerLink, sol, price, short, esc, fmt, STATUS, STATUS_NAME, LAMPORTS } from "./api.js";

const $ = (id) => document.getElementById(id);
const hudLast = {};
function setHud(id, v) {
  const s = String(v);
  if (hudLast[id] === s) return;
  hudLast[id] = s;
  $(id).textContent = s;
}
const setHtml = (id, html) => { const el = $(id); if (el.innerHTML !== html) el.innerHTML = html; };

(async function main() {
  const bootEl = $("boot");
  const world = await boot({ status: (s) => { bootEl.textContent = s; } });
  const { sim, census } = world;
  const live = world.live;
  const config = live ? live.config : {};
  const src = () => live || config;
  const txLink = (sig, n = 8) => sig ? `<a class="chain" href="${explorerLink("tx", sig, src())}" target="_blank" rel="noopener">${short(sig, n)}</a>` : "";
  const addrLink = (a, n = 4) => a ? `<a class="chain" href="${explorerLink("address", a, src())}" target="_blank" rel="noopener">${short(a, n)}</a>` : "\u2014";
  const isMainnet = () => (live ? live.cluster : config.cluster) === "mainnet-beta";
  bootEl.classList.add("gone");
  fillConstants(world);

  const dish = new Dish3D($("dish"), world, { embedded: false, onSelect: onSelect });

  // ---------- windows + dock ----------
  const winState = (() => { try { return JSON.parse(localStorage.getItem("instar_wins") || "{}"); } catch { return {}; } })();
  const saveWins = () => { try { localStorage.setItem("instar_wins", JSON.stringify(winState)); } catch { } };
  let winZ = 20;
  function toggleWin(id, open) {
    const el = $(id);
    const st = winState[id] || (winState[id] = {});
    st.open = open === undefined ? !st.open : open;
    el.classList.toggle("open", !!st.open);
    if (st.open) el.style.zIndex = String(++winZ);
    const db = document.querySelector(`#dock button[data-win="${id}"]`);
    if (db) db.classList.toggle("on", !!st.open);
    saveWins();
    if (st.open) renderWindows();
  }
  function initWin(id, defOpen) {
    const el = $(id);
    const st = winState[id] || (winState[id] = { open: defOpen });
    if (st.open === undefined) st.open = defOpen;
    if (st.x !== undefined && window.innerWidth > 560) {
      el.style.left = Math.min(window.innerWidth - 80, Math.max(0, st.x)) + "px";
      el.style.top = Math.min(window.innerHeight - 40, Math.max(0, st.y)) + "px";
      el.style.right = "auto"; el.style.bottom = "auto"; el.style.transform = "none";
    }
    el.classList.toggle("open", !!st.open);
    el.addEventListener("pointerdown", () => { el.style.zIndex = String(++winZ); });
    const head = el.querySelector(".win-head");
    head.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("button") || window.innerWidth <= 560) return;
      const r = el.getBoundingClientRect();
      const ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      el.style.right = "auto"; el.style.bottom = "auto"; el.style.transform = "none";
      el.style.left = r.left + "px"; el.style.top = r.top + "px";
      const move = (e) => {
        const x = Math.min(window.innerWidth - 80, Math.max(0, e.clientX - ox));
        const y = Math.min(window.innerHeight - 40, Math.max(0, e.clientY - oy));
        el.style.left = x + "px"; el.style.top = y + "px";
        st.x = x; st.y = y;
      };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); saveWins(); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    head.querySelector("[data-min]").addEventListener("click", () => {
      if (id === "win-inspect") dish.select(-1); else toggleWin(id, false);
    });
  }
  const WINS = ["win-market", "win-larvae", "win-mine", "win-activity", "win-brain", "win-account"];
  WINS.forEach(id => initWin(id, id === "win-market" && window.innerWidth > 900));
  initWin("win-inspect", false);
  winState["win-inspect"].open = false; $("win-inspect").classList.remove("open");
  document.querySelectorAll("#dock button[data-win]").forEach(b => {
    b.addEventListener("click", () => toggleWin(b.dataset.win));
    b.classList.toggle("on", !!(winState[b.dataset.win] && winState[b.dataset.win].open));
  });

  // ---------- activity feed ----------
  const plateFeed = [];
  function pushPlate(html) {
    plateFeed.unshift(html);
    plateFeed.length = Math.min(plateFeed.length, 40);
    if (winState["win-activity"]?.open) setHtml("a-events", plateFeed.map(h => `<div class="row"><span class="g">${h}</span></div>`).join(""));
  }
  const EVENT_LABEL = { 3: "flood: pools widen for 1,200 ticks", 4: "yeast bloom", 5: "dry spell: food quartered, moisture down" };
  world.onEvent((ev) => {
    if (ev.tick < world.joinedAt) return; // history, not news
    let msg;
    if (ev.kind === 1) msg = `<b>birth</b> #${ev.uid}${ev.b === 0xff ? " (founder)" : ` of #${world.uids()[ev.b]}`} \u00b7 tick ${fmt(ev.tick)}`;
    else if (ev.kind === 2) msg = `<b>death</b> #${ev.uid} \u00b7 ${DEATH_CAUSE[ev.b] || "?"} \u00b7 tick ${fmt(ev.tick)}`;
    else if (ev.kind === 6) msg = `<b>molt</b> #${ev.uid} \u00b7 tick ${fmt(ev.tick)}`;
    else if (ev.kind === 4) msg = `<b>${EVENT_LABEL[4]}</b> at ${ev.a},${ev.b} \u00b7 tick ${fmt(ev.tick)}`;
    else msg = `<b>${EVENT_LABEL[ev.kind] || "event " + ev.kind}</b> \u00b7 tick ${fmt(ev.tick)}`;
    pushPlate(msg);
  });
  const chainFeed = [];
  function pushChain(html) {
    chainFeed.unshift(html);
    chainFeed.length = Math.min(chainFeed.length, 12);
  }

  // ---------- market / larvae / mine / activity ----------
  let me = null;
  const larvaOf = (uid) => live && live.larvae ? live.larvae.find(l => l.id === uid) : null;
  const keeperName = (pk) => !pk ? "\u2014" : (session && pk === session.wallet) ? "you" : short(pk);
  // lineageNames values are records {name, by, handle, tick}
  const lineageName = (lin) => { const r = live && live.lineageNames ? live.lineageNames[lin] : null; return r ? (typeof r === "string" ? r : r.name) : undefined; };
  const hasParent = (l) => l.parentId !== undefined && l.parentId !== null && l.parentId !== -1 && l.parentId !== "none";
  function statusBadge(l) {
    if (l.status === STATUS.OFFERED) return `<span class="badge sale">offered</span>`;
    if (l.status === STATUS.OWNED && Number(l.salePrice) > 0) return `<span class="badge sale">listed</span>`;
    if (l.status === STATUS.OWNED && session && l.keeper === session.wallet) return `<span class="badge you">yours</span>`;
    if (l.status === STATUS.WILD) return `<span class="badge">wild</span>`;
    if (l.status === STATUS.DEAD) return `<span class="badge">dead</span>`;
    return "";
  }
  // One signed action at a time. The clicked control is disabled while the
  // request is out and its result is written beside it and in the window's
  // own message line, so a Market buy is answered in the Market window.
  let inflight = null;
  function inlineMsg(btn, cls, html) {
    let s = btn.nextElementSibling;
    if (!s || !s.classList.contains("inline-msg")) { s = document.createElement("span"); btn.after(s); }
    s.className = "inline-msg " + cls; s.innerHTML = html;
  }
  async function act(kind, body, okMsg, btn, { chain = true } = {}) {
    const win = btn.closest(".win");
    const m = win ? win.querySelector(".act-msg") : null;
    const say = (cls, html) => { if (m) { m.className = "msg act-msg " + cls; m.innerHTML = html; } inlineMsg(btn, cls, html); };
    if (!session) { say("err", "sign in first (Account)"); toggleWin("win-account", true); return; }
    if (inflight) { say("", `waiting for ${esc(inflight)} to settle`); return; }
    inflight = kind; btn.disabled = true;
    say("", chain ? "signing\u2026" : "sending\u2026");
    try {
      const j = await post("/api/" + kind, body);
      const done = typeof okMsg === "function" ? okMsg(j) : okMsg;
      say("ok", chain ? `${done} ${txLink(j.sig)}` : done);
      if (chain) pushChain(`<b>${esc(kind)}</b> ${body.id !== undefined ? "#" + body.id : ""} ${txLink(j.sig)}`);
      refreshMe();
      setTimeout(poll, 800);
    } catch (e) {
      say("err", esc(e.message));
    } finally {
      inflight = null; btn.disabled = false;
    }
  }
  const idBtn = (id) => `<button class="id" data-sel="${id}" aria-label="inspect larva ${id}">#${id}</button>`;
  const buyBtn = (l, kind, label) => `<button data-${kind}="${l.id}" data-price="${esc(l.salePrice)}">${label}</button>`;
  function row(l) {
    const p = l.status === STATUS.OFFERED || Number(l.salePrice) > 0 ? `${price(l.salePrice)} SOL` : "";
    return `<div class="row">${idBtn(l.id)}<span class="g">gen ${l.generation}${hasParent(l) ? ` of #${l.parentId}` : ""} \u00b7 ${l.status === STATUS.DEAD ? "settled" : "vault " + sol(l.vault)}${statusBadge(l)}</span><span class="v">${p}</span></div>`;
  }
  function renderMarket() {
    if (!winState["win-market"]?.open || inflight) return;
    if (!live) {
      setHtml("m-offers", `<div class="note">no world is reachable from this page, so there is no market; this is a local sandbox</div>`);
      setHtml("m-resale", "");
      return;
    }
    setHud("m-cluster", live.cluster);
    setHud("m-metab", sol(live.metabolism) + " SOL");
    setHud("m-pool", sol(live.pool) + " SOL");
    setHud("m-cap", live.capacity);
    setHud("m-settling", live.settling === false ? "paused: operator out of gas" : `running${live.pendingOps ? `, ${live.pendingOps} pending` : ""}`);
    const offers = (live.larvae || []).filter(l => l.status === STATUS.OFFERED);
    setHtml("m-offers", offers.length
      ? offers.map(l => `<div class="row">${idBtn(l.id)}<span class="g">gen ${l.generation}</span><span class="v">${price(l.salePrice)} SOL</span>${buyBtn(l, "buy", "Buy")}</div>`).join("")
      : `<div class="note">no newborn is offered right now; the next birth will be</div>`);
    const resale = (live.larvae || []).filter(l => l.status === STATUS.OWNED && Number(l.salePrice) > 0);
    setHtml("m-resale", resale.length
      ? resale.map(l => `<div class="row">${idBtn(l.id)}<span class="g">gen ${l.generation} \u00b7 vault ${sol(l.vault)} \u00b7 ${keeperName(l.keeper)}</span><span class="v">${price(l.salePrice)} SOL</span>${session && l.keeper === session.wallet ? "" : buyBtn(l, "buylisted", "Buy")}</div>`).join("")
      : `<div class="note">nothing listed by a keeper</div>`);
  }
  function renderLarvae() {
    if (!winState["win-larvae"]?.open) return;
    if (!live) {
      const alive = world.alive(), uids = world.uids(), gens = world.generations(), en = world.energy();
      let html = "", n = 0;
      for (let i = 0; i < world.MAXP; i++) if (alive[i]) { n++; html += `<div class="row"><button class="id" data-slot="${i}" aria-label="inspect larva ${uids[i]}">#${uids[i]}</button><span class="g">gen ${gens[i]} \u00b7 energy ${fmt(en[i])}</span></div>`; }
      setHud("l-summary", `${n} alive in this sandbox; nothing here is on a chain`);
      setHtml("l-list", html);
      return;
    }
    const all = live.larvae || [];
    const living = all.filter(l => l.status !== STATUS.DEAD).sort((a, b) => Number(b.vault) - Number(a.vault) || a.id - b.id);
    const dead = all.filter(l => l.status === STATUS.DEAD).sort((a, b) => b.id - a.id).slice(0, 20);
    setHud("l-summary", `${living.length} on chain and alive \u00b7 ${living.filter(l => l.status === STATUS.OFFERED || Number(l.salePrice) > 0).length} for sale \u00b7 ${all.length - living.length} settled`);
    setHtml("l-list", living.map(row).join("") + (dead.length ? `<h4>settled</h4>` + dead.map(row).join("") : ""));
  }
  function renderMine() {
    if (!winState["win-mine"]?.open) return;
    if (!live) { setHtml("mine-body", `<div class="note">no world is reachable; there is nothing to keep in a sandbox</div>`); return; }
    if (!session || !me) { setHtml("mine-body", `<div class="note">sign in to see the larvae you keep</div>`); return; }
    const mine = (live.larvae || []).filter(l => l.keeper === session.wallet && l.status === STATUS.OWNED);
    const vaults = mine.reduce((a, l) => a + Number(l.vault), 0);
    setHtml("mine-body",
      `<div class="kv2"><span>balance</span><span>${sol(me.balance)} SOL</span><span>keeping</span><span>${mine.length}</span><span>in vaults</span><span>${sol(vaults)} SOL</span></div>` +
      (mine.length ? `<h4>yours</h4>` + mine.map(row).join("") : `<div class="note" style="margin-top:8px">you keep no larva yet; newborns are in the Market window</div>`));
  }
  const TX_LABEL = { birth: "birth registered", offer: "offered", buy: "bought", buylisted: "resold", list: "listed", unlist: "unlisted", transfer: "transferred", reward: "pool rewards", death: "death settled", cull: "culled", epoch: "epoch posted", heartbeat: "heartbeat", fund: "funded", withdraw: "withdrawn", airdrop: "airdrop" };
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? `${s.toFixed(0)}s` : s < 5400 ? `${(s / 60).toFixed(0)}m` : s < 129600 ? `${(s / 3600).toFixed(0)}h` : `${(s / 86400).toFixed(0)}d`; };
  function renderActivity() {
    if (!winState["win-activity"]?.open) return;
    setHtml("a-events", plateFeed.length ? plateFeed.map(h => `<div class="row"><span class="g">${h}</span></div>`).join("") : `<div class="note">nothing has happened since you joined</div>`);
    if (!live) { setHtml("a-tx", `<div class="note">no chain in a sandbox</div>`); return; }
    const rows = [...(live.txlog || [])].reverse().slice(0, 40);
    setHtml("a-tx", (chainFeed.length ? chainFeed.map(h => `<div class="row"><span class="g">${h}</span></div>`).join("") : "") +
      (rows.length ? rows.map(r => `<div class="row">${r.id !== undefined && r.id !== null ? idBtn(r.id) : `<span class="id"></span>`}<span class="g">${esc(TX_LABEL[r.kind] || r.kind)}${r.ok === false ? " (failed)" : ""}</span><span class="v">${txLink(r.sig)} ${ago(r.t)}</span></div>`).join("")
        : `<div class="note">no transaction yet</div>`));
  }
  function renderWindows() { renderMarket(); renderLarvae(); renderMine(); renderActivity(); renderBrain(); }
  // Every control in a window or the inspector goes through this one handler,
  // so re-rendering a row or the action strip never stacks listeners.
  document.body.addEventListener("click", (ev) => {
    const sel = ev.target.closest("[data-sel]");
    if (sel) { selectUid(+sel.dataset.sel); return; }
    const slot = ev.target.closest("[data-slot]");
    if (slot) { dish.select(+slot.dataset.slot); return; }
    const buy = ev.target.closest("[data-buy]");
    if (buy) { act("buy", { id: +buy.dataset.buy, lamports: buy.dataset.price }, `bought #${buy.dataset.buy}`, buy); return; }
    const bl = ev.target.closest("[data-buylisted]");
    if (bl) { act("buylisted", { id: +bl.dataset.buylisted, lamports: bl.dataset.price }, `bought #${bl.dataset.buylisted}`, bl); return; }
    const a = ev.target.closest("[data-act]");
    if (a) inspectorAction(a.dataset.act, +a.dataset.id, a);
  });
  function selectUid(uid) {
    const slot = world.slotOfUid(uid);
    if (slot < 0) { $("i-msg").className = "msg act-msg"; $("i-msg").textContent = `#${uid} is not on the plate right now`; return; }
    dish.select(slot);
  }

  // ---------- brain raster ----------
  const rasterCv = $("brain-raster");
  const rasterCtx = rasterCv.getContext("2d", { alpha: false });
  const rank = (r) => (r >= 1 && r <= 11 ? 0 : r === 0 ? 1 : 2);
  const brainOrder = census.nodes.map((n, i) => i).sort((a, b) => rank(world.roles[a]) - rank(world.roles[b]) || world.roles[a] - world.roles[b] || a - b);
  $("b-legend").innerHTML = [[0, "unassigned"], [1, "olfactory"], [2, "gustatory ext."], [3, "gustatory phar."], [4, "mechano"], [5, "noci"], [6, "cold"], [7, "warm"], [8, "visual"], [9, "proprio"], [10, "gut"], [11, "resp."], [20, "DN left"], [21, "DN right"], [22, "DN unpaired"], [23, "DN-SEZ feeding"], [24, "ring gland"]]
    .map(([r, n]) => `<span><i style="background:${ROLE_COLOR[r]}"></i>${n}</span>`).join("");
  function renderBrain() {
    if (!winState["win-brain"]?.open) return;
    const N = brainOrder.length;
    const cols = 74, rows = Math.ceil(N / cols);
    const cw = rasterCv.width / cols, ch = rasterCv.height / rows;
    rasterCtx.fillStyle = "#F3EEE3";
    rasterCtx.fillRect(0, 0, rasterCv.width, rasterCv.height);
    if (dish.selected < 0) { setHud("b-summary", "select a larva to watch its neurons"); return; }
    const fired = world.fired();
    const base = dish.selected * world.MAXN;
    let n = 0, ns = 0, nd = 0;
    for (let k = 0; k < N; k++) {
      const idx = brainOrder[k];
      if (!fired[base + idx]) continue;
      const r = world.roles[idx];
      n++; if (r >= 1 && r <= 11) ns++; else if (r >= 20) nd++;
      rasterCtx.fillStyle = ROLE_COLOR[r];
      rasterCtx.fillRect((k % cols) * cw, ((k / cols) | 0) * ch, Math.max(1, cw - 1), Math.max(1, ch - 1));
    }
    setHud("b-summary", `#${world.uids()[dish.selected]} \u00b7 ${n} of ${N} fired this tick \u00b7 ${ns} sensory \u00b7 ${nd} descending / ring gland`);
  }

  // ---------- inspector ----------
  const baseWeights = census.edges.map(e => e.weight);
  let inspKey = "";
  function onSelect(slot) {
    const w = $("win-inspect");
    if (slot < 0) { w.classList.remove("open"); inspKey = ""; return; }
    w.classList.add("open"); w.style.zIndex = String(++winZ);
    $("i-msg").textContent = "";
    updateInspector(true);
  }
  function updateInspector(force = false) {
    const slot = dish.selected;
    if (slot < 0) return;
    if (!world.alive()[slot]) { dish.select(-1); return; }
    const uid = world.uids()[slot];
    const gen = world.generations()[slot], age = world.ages()[slot], en = world.energy()[slot], ecd = world.ecdysone()[slot], lin = world.lineages()[slot], eaten = world.eaten()[slot];
    const genome = world.genome(slot);
    let mutated = 0;
    for (let e = 0; e < baseWeights.length; e++) if (genome[e] !== baseWeights[e]) mutated++;
    const rec = larvaOf(uid);
    const name = lineageName(lin);
    const parent = rec && hasParent(rec) ? ` of #${rec.parentId}` : "";
    setHud("i-title", `Larva #${uid}${live ? "" : " (sandbox)"}`);
    setHtml("i-kv",
      `<span>generation</span><span>${gen}${parent}</span>` +
      `<span>lineage</span><span>${lin}${name ? ` \u201c${esc(name)}\u201d` : ""}</span>` +
      `<span>age</span><span>${fmt(age)} ticks</span>` +
      `<span>energy</span><span>${fmt(en)}</span>` +
      `<span>ecdysone</span><span>${fmt(ecd)}</span>` +
      `<span>eaten</span><span>${fmt(eaten)}</span>` +
      `<span>genome</span><span>${mutated === 0 ? "identical to the census weights" : `${fmt(mutated)} of ${fmt(baseWeights.length)} weights differ from the census`}</span>` +
      (rec ? `<span>keeper</span><span>${rec.keeper ? addrLink(rec.keeper) + (session && rec.keeper === session.wallet ? " (you)" : "") : "none"}</span>` +
        `<span>vault</span><span>${sol(rec.vault)} SOL</span>` +
        `<span>status</span><span>${STATUS_NAME[rec.status]}${rec.pendingCull ? ", cull requested" : ""}</span>` +
        (Number(rec.salePrice) > 0 ? `<span>price</span><span>${price(rec.salePrice)} SOL</span>` : "")
        : (live ? `<span>chain</span><span>registration pending</span>` : "")));
    const art = $("i-art");
    if (live) { const s = `${API}/api/larva/${uid}.svg`; if (art.getAttribute("src") !== s) art.src = s; art.hidden = false; } else art.hidden = true;
    const mine = rec && session && rec.keeper === session.wallet && rec.status === STATUS.OWNED;
    const key = rec ? `${uid}:${rec.status}:${rec.salePrice}:${mine}` : `${uid}:none`;
    if (!force && key === inspKey) return;
    inspKey = key;
    let actions = "";
    if (rec) {
      if (rec.status === STATUS.OFFERED) actions = buyBtn(rec, "buy", `Buy for ${price(rec.salePrice)} SOL`);
      else if (rec.status === STATUS.OWNED && Number(rec.salePrice) > 0 && !mine) actions = buyBtn(rec, "buylisted", `Buy for ${price(rec.salePrice)} SOL`);
      else if (mine) {
        actions = (Number(rec.salePrice) > 0
          ? `<button data-act="unlist" data-id="${uid}">Unlist</button>`
          : `<input id="iv-price" placeholder="SOL" aria-label="listing price in SOL" inputmode="decimal"><button data-act="list" data-id="${uid}">List</button>`) +
          `<input id="iv-to" placeholder="to address" aria-label="transfer to this Solana address" style="width:150px"><button data-act="transfer" data-id="${uid}">Transfer</button>` +
          `<input id="iv-name" placeholder="name lineage ${lin}" aria-label="name for lineage ${lin}" maxlength="32"><button data-act="name" data-id="${uid}" class="quiet">Name</button>`;
      }
    }
    setHtml("i-market", actions ? `<div class="actions">${actions}</div>` : "");
  }
  // Inspector controls, dispatched from the body click handler. The inputs
  // are read when the button is pressed, never captured at render time.
  function inspectorAction(kind, uid, btn) {
    const fail = (text) => { const m = $("i-msg"); m.className = "msg act-msg err"; m.textContent = text; inlineMsg(btn, "err", esc(text)); };
    if (kind === "unlist") act("unlist", { id: uid }, `#${uid} unlisted`, btn);
    else if (kind === "list") {
      const p = parseFloat($("iv-price").value);
      if (!(p > 0)) { fail("enter a price in SOL"); return; }
      const lamports = String(Math.round(p * LAMPORTS));
      act("list", { id: uid, lamports }, `#${uid} listed at ${price(lamports)} SOL`, btn);
    } else if (kind === "transfer") {
      const to = $("iv-to").value.trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) { fail("enter a Solana address"); return; }
      act("transfer", { id: uid, to }, `#${uid} transferred to ${short(to)}`, btn);
    } else if (kind === "name") {
      const name = $("iv-name").value.trim();
      if (!name) { fail("enter a name"); return; }
      act("name-lineage", { id: uid, name }, (j) => `lineage ${j.lineage} is now \u201c${esc(j.name ?? name)}\u201d`, btn, { chain: false });
    }
  }

  // ---------- account ----------
  const msg = (id, text, cls = "") => { const m = $(id); m.className = "msg " + cls; m.textContent = text; };
  async function refreshMe() {
    if (!session || !live) return;
    try {
      me = await post("/api/me", {});
      session.wallet = me.wallet; if (me.name) session.name = me.name; setSession(session);
      setHud("acct-name", me.name || me.user || "you");
      setHud("acct-balance", sol(me.balance) + " SOL");
      setHud("acct-credit", sol(me.credit) + " SOL" + (Number(me.credit) > 0 ? " (claim it below)" : ""));
      setHud("acct-owned", (me.owned || []).length);
      setHud("acct-deposit", me.wallet);
      setHud("acct-cluster", live.cluster);
      $("acct-scan").href = explorerLink("address", me.wallet, live);
      if (hudLast.qr !== me.wallet) { drawQR($("acct-qr"), me.wallet, { scale: 4 }); hudLast.qr = me.wallet; }
      $("acct-airdrop").hidden = isMainnet();
      withdrawLabel();
      renderMine();
    } catch (e) {
      if (e.status === 401 || e.status === 403) signOut();
    }
  }
  function renderAcct() {
    $("acct-out").hidden = !!session;
    $("acct-in").hidden = !session;
    if (session) refreshMe();
  }
  function signIn(j) { setSession({ token: j.token, user: j.user, name: j.name, wallet: j.wallet }); msg("acct-msg2", ""); renderAcct(); renderMine(); }
  function signOut() { setSession(null); me = null; msg("acct-msg2", ""); renderAcct(); renderMine(); }
  async function auth(create) {
    const user = $("acct-user").value.trim(), pin = $("acct-pin").value;
    if (!user || !pin) { msg("acct-msg", "name and pin are both needed", "err"); return; }
    if (!live) { msg("acct-msg", "no world is reachable from this page", "err"); return; }
    if (!SAME_ORIGIN_API) { msg("acct-msg", "sign in on the world's own address; this page will not send a PIN elsewhere", "err"); return; }
    msg("acct-msg", create ? "creating\u2026" : "signing in\u2026");
    try {
      const j = await post("/api/auth", create ? { user, pin, create: true } : { user, pin });
      signIn(j);
      msg("acct-msg", "");
    } catch (e) { msg("acct-msg", e.message, "err"); }
  }
  $("acct-login").addEventListener("click", () => auth(false));
  $("acct-create").addEventListener("click", () => auth(true));
  $("acct-pin").addEventListener("keydown", (e) => { if (e.key === "Enter") auth(false); });
  $("acct-logout").addEventListener("click", signOut);
  $("acct-copy").addEventListener("click", async () => {
    const addr = session && session.wallet;
    if (!addr) return;
    try { await navigator.clipboard.writeText(addr); msg("acct-msg2", "address copied", "ok"); }
    catch { msg("acct-msg2", addr); }
  });
  $("acct-airdrop").addEventListener("click", async () => {
    const b = $("acct-airdrop"); b.disabled = true; msg("acct-msg2", "requesting an airdrop\u2026");
    try {
      const j = await post("/api/airdrop", {});
      if (j.funded) { $("acct-msg2").className = "msg ok"; $("acct-msg2").innerHTML = `airdrop landed ${txLink(j.sig)}`; }
      else msg("acct-msg2", j.note || "nothing sent", "");
    } catch (e) { msg("acct-msg2", e.message, "err"); }
    setTimeout(() => { b.disabled = false; refreshMe(); }, 2500);
  });
  // With no destination the button claims the program's credit into the
  // custodial wallet; with one it also pays out of that wallet.
  const claiming = () => $("wd-to").value.trim() === "" && !!me && Number(me.credit) > 0;
  function withdrawLabel() { $("acct-withdraw").textContent = claiming() ? "Claim credit" : "Withdraw"; }
  $("wd-to").addEventListener("input", withdrawLabel);
  $("acct-withdraw").addEventListener("click", async () => {
    const to = $("wd-to").value.trim(), amt = $("wd-amt").value.trim().toLowerCase();
    let body;
    if (claiming()) body = {};
    else {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) { msg("acct-msg2", "enter a Solana address", "err"); return; }
      const lamportsArg = amt === "max" ? "max" : String(Math.round(parseFloat(amt) * LAMPORTS));
      if (lamportsArg !== "max" && !(Number(lamportsArg) > 0)) { msg("acct-msg2", "enter an amount in SOL, or max", "err"); return; }
      body = { to, lamports: lamportsArg };
    }
    const b = $("acct-withdraw"); b.disabled = true; msg("acct-msg2", body.to ? "sending\u2026" : "claiming\u2026");
    try {
      const j = await post("/api/withdraw", body);
      $("acct-msg2").className = "msg ok"; $("acct-msg2").innerHTML = `${body.to ? "sent" : "credit claimed"} ${txLink(j.sig)}`;
      $("wd-amt").value = "";
    } catch (e) { msg("acct-msg2", e.message, "err"); }
    setTimeout(() => { b.disabled = false; refreshMe(); }, 2500);
  });
  // Sign in with Google appears only when the world is configured for it; the
  // GSI script is the one third-party request this page can make, and only then.
  if (config.googleClientId) {
    const wrap = $("gwrap"); wrap.hidden = false;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => {
      if (!window.google || !google.accounts) return;
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async (resp) => {
          try { signIn(await post("/api/auth/google", { credential: resp.credential })); }
          catch (e) { msg("acct-msg", e.message, "err"); }
        },
      });
      google.accounts.id.renderButton($("gbtn"), { theme: "outline", size: "medium", shape: "rectangular", text: "continue_with", width: 240 });
    };
    document.head.appendChild(s);
  }
  renderAcct();
  if (live) setInterval(refreshMe, 15000);

  // ---------- first person ----------
  const fpBtn = $("btn-fp"), hint = $("hint"), crosshair = $("crosshair");
  fpBtn.addEventListener("click", () => dish.toggleFirstPerson());
  dish.onFpChange = (on) => {
    fpBtn.textContent = on ? "Leave the agar" : "On the agar";
    crosshair.style.display = on && dish.fp.mode === "locked" ? "block" : "none";
    hint.textContent = on
      ? (dish.fp.mode === "locked" ? "WASD to crawl \u00b7 mouse to look \u00b7 shift to hurry \u00b7 click to inspect \u00b7 esc to leave" : "WASD to crawl \u00b7 hold the mouse to look \u00b7 esc to leave")
      : "drag to orbit \u00b7 wheel to zoom \u00b7 click a larva to inspect";
  };

  // ---------- journal poll ----------
  async function poll() {
    if (!live) return;
    const j = await pollJournal(world, (e) => {
      if (e.type === "cap") pushPlate(`<b>capacity</b> becomes ${e.value} at tick ${fmt(e.tick)}`);
      else if (e.type === "cull") pushPlate(`<b>cull ordered</b> #${e.uid} at tick ${fmt(e.tick)}`);
      else if (e.type === "provision") pushPlate(`<b>provisioned</b> #${e.uid} at tick ${fmt(e.tick)}`);
      else if (e.type === "gen") pushPlate(`<b>founders</b> ${e.n} spawn at tick ${fmt(e.tick)}`);
    }, (ep, st) => {
      // called once when the journal is compared, again when the chain is read
      if (st.chain === true) pushChain(`<b>epoch ${ep.epoch} VERIFIED on chain</b> World.last_state_hash \u2026${esc(st.onChain)} ${txLink(ep.sig)}`);
      else if (st.chain === false) pushChain(`<b>epoch ${ep.epoch} DIVERGED from chain</b> local ${esc(st.local)} chain \u2026${esc(st.onChain)}`);
      else if (st.journal) pushChain(`<b>epoch ${ep.epoch} matches the journal</b> ${esc(ep.hash.slice(0, 12))}\u2026; reading the chain ${txLink(ep.sig)}`);
      else pushChain(`<b>epoch ${ep.epoch} DIVERGED from the journal</b> local ${esc(st.local.slice(0, 12))}\u2026 journal ${esc(ep.hash.slice(0, 12))}\u2026`);
    });
    if (j && j.desynced) { pushPlate("<b>mirror out of step with the journal; reloading</b>"); setTimeout(() => location.reload(), 1200); return; }
    renderWindows();
    // the frame loop also refreshes the inspector, but a hidden tab has no
    // frames: a purchase or listing must show up on the next poll regardless
    updateInspector();
  }
  if (live) { setInterval(poll, 3000); pushPlate(world.joinedAt ? `<b>joined</b> at tick ${fmt(world.joinedAt)} from the world's snapshot; verifying every epoch from here` : `<b>replaying</b> the world from genesis; every epoch will be checked`); }

  // ---------- main loop ----------
  let frame = 0, lastT = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const behind = world.pace(now);
    dish.render(dt);
    frame++;
    setHud("h-tick", fmt(world.tick()));
    setHud("h-epoch", fmt(world.epoch()));
    setHud("h-pop", sim.pop_count());
    setHud("h-cap", world.capacity());
    const light = sim.light_now();
    setHud("h-light", `${light > 128 ? "day" : "night"} ${light}`);
    setHud("h-temp", (sim.temp_now() / 100).toFixed(1) + " \u00b0C");
    if (frame % 60 === 1) setHud("h-hash", world.stateHash().slice(0, 12) + "\u2026");
    {
      let html;
      const v = live && verdict(live);
      if (!live) html = `<b>SANDBOX</b> no world reachable`;
      else if (live.settling === false) html = `<b class="bad">SETTLEMENT PAUSED</b>`;
      else if (behind > 2000) html = `<b class="warn">SYNCING</b> ${fmt(behind)} behind`;
      else if (v) html = `<b class="${v.cls}">${v.word}</b> ${esc(v.detail)}`;
      else html = `<b>LIVE</b> ${esc(live.cluster)}`;
      setHtml("h-state", html);
    }
    if (frame % 3 === 0) renderBrain();
    if (frame % 10 === 2) updateInspector();
    if (frame % 90 === 5 && !live) renderLarvae();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  // headless verification: drive one frame without rAF
  window.__instar = { world, dish, frame: () => { world.pace(performance.now()); dish.render(1 / 60); } };
})().catch(e => {
  const b = document.getElementById("boot");
  b.classList.remove("gone");
  b.textContent = "the dish failed to load: " + e.message;
  console.error(e);
});
