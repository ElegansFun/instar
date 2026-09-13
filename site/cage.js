// cage.html: the bench. Full-screen cage, HUD, dock windows, inspector,
// account. Everything shown is read from the world's stream or its journal;
// the page never invents a number.
import { boot, fetchJournal, verifierLine, verifyEpochHere, canVerifyHere, VERIFY_MEMORY_GB, fillConstants, DEATH_CAUSE, API, SAME_ORIGIN_API } from "./engine.js";
import { Stream } from "./stream.js";
import { Cage3D } from "./cage3d.js";
import { mountBrainPanel } from "./brainmap.js";
import { drawQR } from "./qr.js";
import { session, setSession, post, explorerLink, sol, price, short, esc, fmt, STATUS, STATUS_NAME, LAMPORTS } from "./api.js";
import { Program, loadIdl, identityDrift, rememberIdentity } from "./chain.js";
import { wallets, onWallets } from "./wallet.js";

const $ = (id) => document.getElementById(id);
const hudLast = {};
function setHud(id, v) {
  const s = String(v);
  if (hudLast[id] === s) return;
  hudLast[id] = s;
  $(id).textContent = s;
}
const setHtml = (id, html) => { const el = $(id); if (el.innerHTML !== html) el.innerHTML = html; };
const SURFACE_NAME = ["floor", "west wall", "east wall", "north wall", "south wall", "lid"];

(async function main() {
  const bootEl = $("boot");
  const { journal, config } = await boot({ status: (s) => { bootEl.textContent = s; } });
  if (!journal) throw new Error(API ? "no world answers at " + API : "this page must be served by the world process (or given ?api= in dev)");
  if (!config.arena) throw new Error("the world did not publish its arena");
  const live = journal;
  const src = () => live;
  const txLink = (sig, n = 8) => sig ? `<a class="chain" href="${esc(explorerLink("tx", sig, src()))}" target="_blank" rel="noopener">${esc(short(sig, n))}</a>` : "";
  const addrLink = (a, n = 4) => a ? `<a class="chain" href="${esc(explorerLink("address", a, src()))}" target="_blank" rel="noopener">${esc(short(a, n))}</a>` : "\u2014";
  const isMainnet = () => live.cluster === "mainnet-beta";
  bootEl.classList.add("gone");
  fillConstants(config, journal);
  // The program and collection this browser first saw are remembered; a
  // world that names different ones since gets a red banner until the
  // visitor accepts the change, and wallet mode also refuses any program
  // but the one pinned in chain.js.
  {
    const seen = identityDrift(config);
    if (seen) {
      const b = $("identity-banner");
      b.hidden = false;
      setHtml("identity-text", `this world's chain identity changed since your first visit: program ${esc(short(seen.programId, 6))} \u2192 ${esc(short(config.programId, 6))}, collection ${esc(short(seen.collection, 6))} \u2192 ${esc(short(config.collection, 6))}. Do not sign anything unless you expected this.`);
      $("identity-accept").addEventListener("click", () => { rememberIdentity(config); b.hidden = true; });
    }
  }

  const cage = new Cage3D($("cage"), { arena: config.arena, maxPop: config.maxPop || 64, embedded: false, onSelect: onSelect });
  const stream = new Stream({ onEvent: onStreamEvent, onState: () => {} });
  let flies = [];

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
    if (id === "win-brain") watchBrain();
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
      if (id === "win-inspect") cage.select(-1); else toggleWin(id, false);
    });
  }
  const WINS = ["win-market", "win-flies", "win-mine", "win-activity", "win-brain", "win-account"];
  WINS.forEach(id => initWin(id, id === "win-market" && window.innerWidth > 900));
  initWin("win-inspect", false);
  winState["win-inspect"].open = false; $("win-inspect").classList.remove("open");
  document.querySelectorAll("#dock button[data-win]").forEach(b => {
    b.addEventListener("click", () => toggleWin(b.dataset.win));
    b.classList.toggle("on", !!(winState[b.dataset.win] && winState[b.dataset.win].open));
  });

  // ---------- activity feed ----------
  const cageFeed = [];
  function pushCage(html) {
    cageFeed.unshift(html);
    cageFeed.length = Math.min(cageFeed.length, 40);
    if (winState["win-activity"]?.open) setHtml("a-events", cageFeed.map(h => `<div class="row"><span class="g">${h}</span></div>`).join(""));
  }
  const EVENT_LABEL = { lights_off: "lights off", bloom: "yeast bloom", dry_spell: "dry spell: food quartered, humidity down", mature: "mature", takeoff: "takeoff", landing: "landing" };
  let joinedAt = -1;
  function onStreamEvent(ev) {
    if (joinedAt < 0) joinedAt = ev.tick;
    const who = ev.uid !== undefined && ev.uid !== null && ev.uid >= 0 ? `#${ev.uid}` : "";
    let msg;
    if (ev.name === "birth") msg = `<b>birth</b> ${who} \u00b7 tick ${fmt(ev.tick)}`;
    else if (ev.name === "death") msg = `<b>death</b> ${who} \u00b7 ${esc(ev.cause || DEATH_CAUSE[ev.b] || "?")} \u00b7 tick ${fmt(ev.tick)}`;
    else if (ev.name === "landing") msg = `<b>landing</b> ${who} on the ${SURFACE_NAME[ev.b] || "cage"} \u00b7 tick ${fmt(ev.tick)}`;
    else msg = `<b>${esc(EVENT_LABEL[ev.name] || ev.name || "event " + ev.kind)}</b> ${who} \u00b7 tick ${fmt(ev.tick)}`;
    pushCage(msg);
  }
  const chainFeed = [];
  function pushChain(html) {
    chainFeed.unshift(html);
    chainFeed.length = Math.min(chainFeed.length, 12);
  }

  // ---------- market / flies / mine / activity ----------
  let me = null;
  // Who is acting: the custodial session's wallet, or in wallet mode the
  // connected wallet. Every "yours" test on the page goes through myAddr().
  let acctMode = (() => { try { return localStorage.getItem("instar_acct_mode") === "wallet" ? "wallet" : "custodial"; } catch { return "custodial"; } })();
  let wallet = null;   // the connected adapter from wallet.js
  let program = null;  // chain.js Program, built once the IDL has been read
  let walletBal = { balance: 0n, credit: 0n };
  const walletMode = () => acctMode === "wallet";
  const myAddr = () => walletMode() ? (wallet ? wallet.address : null) : (session ? session.wallet : null);
  const records = () => live.flies || [];
  const flyOf = (uid) => records().find(l => l.id === uid);
  const keeperName = (pk) => !pk ? "\u2014" : pk === myAddr() ? "you" : short(pk);
  // lineageNames values are records {name, by, handle, tick}
  const lineageName = (lin) => { const r = live.lineageNames ? live.lineageNames[lin] : null; return r ? (typeof r === "string" ? r : r.name) : undefined; };
  const hasParent = (l) => l.parentId !== undefined && l.parentId !== null && l.parentId !== -1 && l.parentId !== "none";
  function statusBadge(l) {
    if (l.status === STATUS.OFFERED) return `<span class="badge sale">offered</span>`;
    if (l.status === STATUS.OWNED && Number(l.salePrice) > 0) return `<span class="badge sale">listed</span>`;
    if (l.status === STATUS.OWNED && l.keeper === myAddr()) return `<span class="badge you">yours</span>`;
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
    if (inflight) { say("", `waiting for ${esc(inflight)} to settle`); return; }
    if (walletMode() && chain) return walletAct(kind, body, okMsg, btn, say);
    if (!session) { say("err", walletMode() ? "this needs an Instar account (Account)" : "sign in first (Account)"); toggleWin("win-account", true); return; }
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
  // Wallet mode: the page builds the instruction from the IDL, the wallet
  // signs, the RPC named by the world carries it, and the journal is polled
  // until the world has read the change back from the chain. The price the
  // visitor saw is the price the program is told, so a relisting in between
  // is refused (WrongPrice), never silently paid.
  async function walletAct(kind, body, okMsg, btn, say) {
    if (!wallet || !wallet.address || !program) { say("err", "connect your wallet first (Account)"); toggleWin("win-account", true); return; }
    const who = wallet.address;
    const rec = body.id !== undefined ? flyOf(body.id) : null;
    if (body.id !== undefined && !rec) { say("err", `#${body.id} is not on the record yet`); return; }
    let ix, settled = null, landed = null;
    try {
      if (kind === "buy") { ix = program.buy(who, rec, body.lamports); settled = (l) => l.keeper === who; }
      else if (kind === "buylisted") { ix = program.buyListed(who, rec, body.lamports); settled = (l) => l.keeper === who; }
      else if (kind === "list") { ix = program.list(who, rec, body.lamports); settled = (l) => String(l.salePrice) === String(body.lamports); }
      else if (kind === "unlist") { ix = program.unlist(who, rec); settled = (l) => Number(l.salePrice) === 0; }
      else if (kind === "transfer") { ix = program.transferAsset(who, rec, body.to); settled = (l) => l.keeper === body.to; }
      else if (kind === "cull") { ix = program.requestCull(who, rec); settled = (l) => !!l.pendingCull; }
      else if (kind === "withdraw") { ix = program.withdraw(who); landed = async () => (await program.credit(who)) === 0n; }
      else { say("err", `${kind} needs an Instar account`); return; }
    } catch (e) { say("err", esc(e.message)); return; }
    // An expired transaction is re-checked against the record before the
    // wallet is asked to sign again: a few journal polls, or the credit
    // account for a withdrawal.
    if (settled) landed = () => untilJournal(body.id, settled, 3);
    inflight = kind; btn.disabled = true;
    say("", "waiting for your wallet\u2026");
    try {
      const sig = await program.send(wallet, who, [ix], { landed });
      const done = typeof okMsg === "function" ? okMsg({ sig }) : okMsg;
      pushChain(`<b>${esc(kind)}</b> ${body.id !== undefined ? "#" + body.id : ""} ${txLink(sig)} signed by your wallet`);
      if (settled) {
        say("ok", `${done} ${txLink(sig)}; waiting for the world to read it\u2026`);
        await untilJournal(body.id, settled);
      }
      say("ok", `${done} ${txLink(sig)}`);
    } catch (e) {
      say("err", esc(e.message));
    } finally {
      inflight = null; btn.disabled = false;
    }
    refreshWallet();
    renderWindows();
    updateInspector(true);
  }
  // The world re-reads the chain every few seconds; keep polling the journal
  // until this fly's record shows the change, or give up after `tries`
  // polls two seconds apart (15 = 30 s).
  async function untilJournal(id, pred, tries = 15) {
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, 2000));
      await poll();
      const l = flyOf(id);
      if (l && pred(l)) return true;
    }
    return false;
  }
  const idBtn = (id) => `<button class="id" data-sel="${id}" aria-label="inspect fly ${id}">#${id}</button>`;
  const buyBtn = (l, kind, label) => `<button data-${kind}="${l.id}" data-price="${esc(l.salePrice)}">${label}</button>`;
  function row(l) {
    const p = l.status === STATUS.OFFERED || Number(l.salePrice) > 0 ? `${price(l.salePrice)} SOL` : "";
    return `<div class="row">${idBtn(l.id)}<span class="g">gen ${l.generation}${hasParent(l) ? ` of #${l.parentId}` : ""} \u00b7 ${l.status === STATUS.DEAD ? "settled" : "vault " + sol(l.vault)}${statusBadge(l)}</span><span class="v">${p}</span></div>`;
  }
  function renderMarket() {
    if (!winState["win-market"]?.open || inflight) return;
    setHud("m-cluster", live.cluster);
    setHud("m-metab", sol(live.metabolism) + " SOL");
    setHud("m-pool", sol(live.pool) + " SOL");
    setHud("m-cap", live.capacity);
    setHud("m-settling", live.settling === false ? "paused: operator out of gas" : `running${live.pendingOps ? `, ${live.pendingOps} pending` : ""}`);
    const offers = records().filter(l => l.status === STATUS.OFFERED);
    setHtml("m-offers", offers.length
      ? offers.map(l => `<div class="row">${idBtn(l.id)}<span class="g">gen ${l.generation}</span><span class="v">${price(l.salePrice)} SOL</span>${buyBtn(l, "buy", "Buy")}</div>`).join("")
      : `<div class="note">no newborn is offered right now; the next birth will be</div>`);
    const resale = records().filter(l => l.status === STATUS.OWNED && Number(l.salePrice) > 0);
    setHtml("m-resale", resale.length
      ? resale.map(l => `<div class="row">${idBtn(l.id)}<span class="g">gen ${l.generation} \u00b7 vault ${sol(l.vault)} \u00b7 ${keeperName(l.keeper)}</span><span class="v">${price(l.salePrice)} SOL</span>${l.keeper === myAddr() ? "" : buyBtn(l, "buylisted", "Buy")}</div>`).join("")
      : `<div class="note">nothing listed by a keeper</div>`);
  }
  function renderFlies() {
    if (!winState["win-flies"]?.open) return;
    const all = records();
    const living = all.filter(l => l.status !== STATUS.DEAD).sort((a, b) => Number(b.vault) - Number(a.vault) || a.id - b.id);
    const dead = all.filter(l => l.status === STATUS.DEAD).sort((a, b) => b.id - a.id).slice(0, 20);
    const flying = flies.filter(f => f.mode === 1).length;
    setHud("l-summary", `${living.length} on chain and alive \u00b7 ${flies.length} in the cage, ${flying} flying \u00b7 ${living.filter(l => l.status === STATUS.OFFERED || Number(l.salePrice) > 0).length} for sale \u00b7 ${all.length - living.length} settled`);
    setHtml("l-list", living.map(row).join("") + (dead.length ? `<h4>settled</h4>` + dead.map(row).join("") : ""));
  }
  function renderMine() {
    if (!winState["win-mine"]?.open) return;
    const who = myAddr();
    if (!who || (!walletMode() && !me)) { setHtml("mine-body", `<div class="note">${walletMode() ? "connect your wallet" : "sign in"} to see the flies you keep</div>`); return; }
    const mine = records().filter(l => l.keeper === who && l.status === STATUS.OWNED);
    const vaults = mine.reduce((a, l) => a + Number(l.vault), 0);
    const balance = walletMode() ? walletBal.balance : me.balance;
    setHtml("mine-body",
      `<div class="kv2"><span>balance</span><span>${sol(balance)} SOL</span><span>keeping</span><span>${mine.length}</span><span>in vaults</span><span>${sol(vaults)} SOL</span></div>` +
      (mine.length ? `<h4>yours</h4>` + mine.map(row).join("") : `<div class="note" style="margin-top:8px">you keep no fly yet; newborns are in the Market window</div>`));
  }
  const TX_LABEL = { birth: "birth registered", offer: "offered", buy: "bought", buylisted: "resold", list: "listed", unlist: "unlisted", transfer: "transferred", reward: "pool rewards", death: "death settled", cull: "culled", epoch: "epoch posted", heartbeat: "heartbeat", fund: "funded", withdraw: "withdrawn", airdrop: "airdrop" };
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? `${s.toFixed(0)}s` : s < 5400 ? `${(s / 60).toFixed(0)}m` : s < 129600 ? `${(s / 3600).toFixed(0)}h` : `${(s / 86400).toFixed(0)}d`; };
  function renderActivity() {
    if (!winState["win-activity"]?.open) return;
    setHtml("a-events", cageFeed.length ? cageFeed.map(h => `<div class="row"><span class="g">${h}</span></div>`).join("") : `<div class="note">nothing has happened since you joined</div>`);
    const rows = [...(live.txlog || [])].reverse().slice(0, 40);
    setHtml("a-tx", (chainFeed.length ? chainFeed.map(h => `<div class="row"><span class="g">${h}</span></div>`).join("") : "") +
      (rows.length ? rows.map(r => `<div class="row">${r.id !== undefined && r.id !== null ? idBtn(r.id) : `<span class="id"></span>`}<span class="g">${esc(TX_LABEL[r.kind] || r.kind)}${r.ok === false ? " (failed)" : ""}</span><span class="v">${txLink(r.sig)} ${ago(r.t)}</span></div>`).join("")
        : `<div class="note">no transaction yet</div>`));
    renderVerification();
  }
  function renderWindows() { renderMarket(); renderFlies(); renderMine(); renderActivity(); renderBrain(); }
  // Every control in a window or the inspector goes through this one handler,
  // so re-rendering a row or the action strip never stacks listeners.
  document.body.addEventListener("click", (ev) => {
    const sel = ev.target.closest("[data-sel]");
    if (sel) { selectUid(+sel.dataset.sel); return; }
    const buy = ev.target.closest("[data-buy]");
    if (buy) { act("buy", { id: +buy.dataset.buy, lamports: buy.dataset.price }, `bought #${buy.dataset.buy}`, buy); return; }
    const bl = ev.target.closest("[data-buylisted]");
    if (bl) { act("buylisted", { id: +bl.dataset.buylisted, lamports: bl.dataset.price }, `bought #${bl.dataset.buylisted}`, bl); return; }
    const a = ev.target.closest("[data-act]");
    if (a) inspectorAction(a.dataset.act, +a.dataset.id, a);
  });
  function selectUid(uid) {
    if (!cage.flyById(uid)) { $("i-msg").className = "msg act-msg"; $("i-msg").textContent = `#${uid} is not in the cage right now`; return; }
    cage.select(uid);
  }

  // ---------- verification ----------
  // What this page can say: the CLI verifier's posted record, and, on a
  // desktop, a replay here: from the latest snapshot to the next epoch the
  // world posts, or from a retained pre-boundary snapshot to an epoch
  // already posted.
  let verifying = false, verifyResult = null;
  const verifyBtn = $("v-run"), verifyPostedBtn = $("v-run-posted");
  const offerVerify = canVerifyHere();
  verifyBtn.hidden = !offerVerify;
  document.querySelectorAll('[data-n="vmem"]').forEach(el => { el.textContent = String(VERIFY_MEMORY_GB); });
  // the newest posted epoch the world still holds a pre-boundary snapshot for
  const postedVerifiable = () => {
    const kept = Array.isArray(live.snapshotEpochs) ? live.snapshotEpochs : [];
    const posted = new Set((live.epochs || []).map(e => e.epoch));
    return kept.filter(n => posted.has(n)).sort((a, b) => b - a)[0] ?? null;
  };
  function renderVerification() {
    const v = verifierLine(live);
    let html = v
      ? `<b class="${v.cls}">${v.word}</b> ${esc(v.detail)}${v.sig ? " " + txLink(v.sig) : ""}`
      : `no CLI verifier result has been posted to this world's journal; the epochs below are the operator's hashes, compared with nothing by this page`;
    if (verifyResult) {
      const r = verifyResult;
      const chain = r.chain === true ? `<b class="ok">VERIFIED on chain</b> World.last_state_hash \u2026${esc(r.onChain)}` : r.chain === false ? `<b class="bad">DIVERGED from chain</b> chain \u2026${esc(r.onChain)}` : `chain not compared: ${esc(r.chainError)}`;
      const jr = r.journal === true ? `matches the journal` : r.journal === false ? `<b class="bad">DIFFERS from the journal</b> (posted ${esc(r.posted.hash)})` : `epoch ${r.epoch} is not in the journal`;
      html += `<br><b>this browser</b> replayed ${fmt(r.ticks)} ticks from the snapshot at tick ${fmt(r.snapshotTick)} to epoch ${r.epoch} in ${(r.ms / 1000).toFixed(0)} s, holding ${(r.peakBytes / 1073741824).toFixed(2)} GB at most (engine image ${(r.imageBytes / 1048576).toFixed(0)} MB): hash ${esc(r.local)}, ${jr}; ${chain}`;
    }
    setHtml("v-line", html);
    const nextEpoch = Math.floor((stream.t || live.tick) / live.epochInterval) + 1;
    verifyBtn.textContent = verifying ? "verifying\u2026" : `Verify the next epoch (${nextEpoch}) in this browser`;
    verifyBtn.disabled = verifying;
    const pv = postedVerifiable();
    verifyPostedBtn.hidden = !offerVerify || pv === null;
    verifyPostedBtn.textContent = verifying ? "verifying\u2026" : `Verify posted epoch ${pv}`;
    verifyPostedBtn.disabled = verifying;
  }
  async function runVerify(epoch) {
    if (verifying) return;
    const what = epoch === null ? "the world's latest snapshot and replays to the next epoch boundary, then waits for the world to post it (up to ten minutes)" : `the snapshot the world kept before epoch ${epoch} and replays to that boundary`;
    if (!confirm(`This downloads the canonical graph (~82 MB) and ${what}. The worker streams the ~0.7 GB snapshot straight into the engine's memory and holds about ${VERIFY_MEMORY_GB} GB at its peak (measured: 0.68 GB in the worker, 1.4 GB for the whole tab). It can take several minutes. Continue?`)) return;
    verifying = true; renderVerification();
    const m = $("v-msg"); m.className = "msg"; m.textContent = "starting the worker";
    try {
      const fresh = await fetchJournal(8000);
      if (fresh) Object.assign(live, { entries: fresh.entries, epochs: fresh.epochs, tick: fresh.tick, bufferTicks: fresh.bufferTicks, snapshotEpochs: fresh.snapshotEpochs, era: fresh.era, seed: fresh.seed });
      verifyResult = await verifyEpochHere({ journal: live, config, epoch, status: (s) => { m.textContent = s; } });
      const verdict = verifyResult.chain === true ? "VERIFIED" : verifyResult.chain === false || verifyResult.journal === false ? "MISMATCH" : "replayed";
      m.className = verdict === "VERIFIED" ? "msg ok" : verdict === "MISMATCH" ? "msg err" : "msg";
      m.textContent = `${verdict}: epoch ${verifyResult.epoch} in ${(verifyResult.ms / 1000).toFixed(0)} s`;
      pushChain(verifyResult.chain === true
        ? `<b>epoch ${verifyResult.epoch} VERIFIED on chain by this browser</b> ${esc(verifyResult.local)}`
        : verifyResult.chain === false || verifyResult.journal === false
          ? `<b>epoch ${verifyResult.epoch} DIVERGED</b> local ${esc(verifyResult.local)}`
          : `<b>epoch ${verifyResult.epoch} replayed here</b> ${esc(verifyResult.local)}, ${verifyResult.journal ? "matches the journal" : "not in the journal"}`);
    } catch (e) {
      m.className = "msg err"; m.textContent = e.message;
    } finally {
      verifying = false; renderVerification();
    }
  }
  verifyBtn.addEventListener("click", () => runVerify(null));
  verifyPostedBtn.addEventListener("click", () => { const pv = postedVerifiable(); if (pv !== null) runVerify(pv); });

  // ---------- brain window ----------
  const brain = mountBrainPanel({ bars: $("brain-bars"), raster: $("brain-raster"), config });
  let rasterInfo = null, rasterErr = null;
  function watchBrain() {
    const id = winState["win-brain"]?.open && cage.selected >= 0 ? cage.selected : -1;
    brain.watch(id, (info, err) => { rasterInfo = info; rasterErr = err; });
  }
  function renderBrain() {
    if (!winState["win-brain"]?.open) return;
    const id = cage.selected;
    const f = id >= 0 ? cage.flyById(id) : null;
    if (!f) { setHud("b-summary", "select a fly to watch its neurons"); setHud("b-caption", `The raster samples every ${brain.stride}th neuron in canonical order: ${fmt(brain.sampled)} of ${fmt(brain.nodes)}, one ${brain.dot}\u00d7${brain.dot} dot each, drawn when that neuron fired at the world's latest tick. It is read from the world (/api/fly/:id/fired) four times a second while this window is open, so it lags the cage by up to a quarter second.`); brain.bars(null); return; }
    brain.bars(f.fired);
    const any = f.fired ? f.fired.any : undefined;
    setHud("b-summary", `#${id} \u00b7 ${f.mode ? "flying" : "walking"} \u00b7 ${any !== undefined ? `${fmt(any)} of ${fmt(brain.nodes)} fired at tick ${fmt(stream.t)}` : `tick ${fmt(stream.t)}`}`);
    setHud("b-caption", (rasterErr ? `raster: ${rasterErr}. ` : rasterInfo ? `${fmt(rasterInfo.lit)} of the ${fmt(rasterInfo.sampled)} sampled neurons fired. ` : "") +
      `The raster samples every ${brain.stride}th neuron in canonical order: ${fmt(brain.sampled)} of ${fmt(brain.nodes)}, one ${brain.dot}\u00d7${brain.dot} dot each, drawn when that neuron fired at the world's latest tick. It is read from the world (/api/fly/${id}/fired) four times a second while this window is open, so it lags the cage by up to a quarter second.`);
  }

  // ---------- inspector ----------
  let inspKey = "";
  function onSelect(id) {
    const w = $("win-inspect");
    watchBrain();
    if (id < 0) { w.classList.remove("open"); inspKey = ""; return; }
    w.classList.add("open"); w.style.zIndex = String(++winZ);
    $("i-msg").textContent = "";
    updateInspector(true);
  }
  function updateInspector(force = false) {
    const uid = cage.selected;
    if (uid < 0) return;
    const f = cage.flyById(uid);
    if (!f) { cage.select(-1); return; }
    const latest = stream.latest(uid) || f;
    const rec = flyOf(uid);
    const lin = latest.lin;
    const name = lin !== undefined ? lineageName(lin) : undefined;
    const parent = rec && hasParent(rec) ? ` of #${rec.parentId}` : "";
    setHud("i-title", `Fly #${uid}`);
    const fired = latest.fired || {};
    setHtml("i-kv",
      `<span>generation</span><span>${rec ? rec.generation + parent : "\u2014"}</span>` +
      (lin !== undefined ? `<span>lineage</span><span>${lin}${name ? ` \u201c${esc(name)}\u201d` : ""}</span>` : "") +
      (latest.age !== undefined ? `<span>age</span><span>${fmt(latest.age)} ticks</span>` : rec && rec.birthTick !== undefined ? `<span>born</span><span>tick ${fmt(rec.birthTick)}</span>` : "") +
      `<span>energy</span><span>${fmt(latest.e)}</span>` +
      `<span>mode</span><span>${latest.mode ? "flying" : `walking on the ${SURFACE_NAME[latest.s] || "cage"}`}</span>` +
      `<span>altitude</span><span>${latest.z.toFixed(1)} of ${config.arena.layers} layers</span>` +
      `<span>position</span><span>${latest.x.toFixed(0)}, ${latest.y.toFixed(0)} \u00b7 heading ${((latest.h * 180 / Math.PI + 360) % 360).toFixed(0)}\u00b0${latest.mode ? ` \u00b7 pitch ${(latest.p * 180 / Math.PI).toFixed(0)}\u00b0` : ""}</span>` +
      `<span>proboscis</span><span>${(latest.pr * 100).toFixed(0)}% extended</span>` +
      `<span>fired</span><span>${fired.any !== undefined ? fmt(fired.any) + " neurons" : "\u2014"} \u00b7 sensory ${fmt(fired.sens)} \u00b7 DN ${fmt(fired.dn)} \u00b7 legs ${fmt((fired.legL || 0) + (fired.legR || 0))} \u00b7 wings ${fmt((fired.wingP || 0) + (fired.wingS || 0))}</span>` +
      (rec ? `<span>keeper</span><span>${rec.keeper ? addrLink(rec.keeper) + (rec.keeper === myAddr() ? " (you)" : "") : "none"}</span>` +
        (rec.asset ? `<span>NFT</span><span>${addrLink(rec.asset)}</span>` : "") +
        (rec.genomeHash ? `<span>genome</span><span>${esc(String(rec.genomeHash))}</span>` : "") +
        `<span>vault</span><span>${sol(rec.vault)} SOL</span>` +
        `<span>status</span><span>${STATUS_NAME[rec.status]}${rec.pendingCull ? ", cull requested" : ""}</span>` +
        (Number(rec.salePrice) > 0 ? `<span>price</span><span>${price(rec.salePrice)} SOL</span>` : "")
        : `<span>chain</span><span>registration pending</span>`));
    const art = $("i-art");
    { const s = `${API}/api/fly/${uid}.svg`; if (art.getAttribute("src") !== s) art.src = s; art.hidden = false; }
    const mine = rec && rec.keeper === myAddr() && rec.status === STATUS.OWNED;
    const key = rec ? `${uid}:${rec.status}:${rec.salePrice}:${rec.pendingCull}:${mine}:${acctMode}` : `${uid}:none`;
    if (!force && key === inspKey) return;
    inspKey = key;
    let actions = "";
    if (rec) {
      if (rec.status === STATUS.OFFERED) actions = buyBtn(rec, "buy", `Buy for ${price(rec.salePrice)} SOL`);
      else if (rec.status === STATUS.OWNED && Number(rec.salePrice) > 0 && !mine) actions = buyBtn(rec, "buylisted", `Buy for ${price(rec.salePrice)} SOL`);
      else if (mine) {
        // Naming is a journal claim the world verifies against the custodial
        // session, so it is offered there; a cull request is a program
        // instruction the wallet can sign, and the custodial API has no
        // route for it, so it is offered here.
        actions = (Number(rec.salePrice) > 0
          ? `<button data-act="unlist" data-id="${uid}">Unlist</button>`
          : `<input id="iv-price" placeholder="SOL" aria-label="listing price in SOL" inputmode="decimal"><button data-act="list" data-id="${uid}">List</button>`) +
          `<input id="iv-to" placeholder="to address" aria-label="transfer to this Solana address" style="width:150px"><button data-act="transfer" data-id="${uid}">Transfer</button>` +
          (walletMode()
            ? (rec.pendingCull ? "" : `<button data-act="cull" data-id="${uid}" class="quiet" title="ask the world to end this fly; 85% of its vault becomes your credit">Request cull</button>`)
            : `<input id="iv-name" placeholder="name its lineage" aria-label="name for this fly's lineage" maxlength="32"><button data-act="name" data-id="${uid}" class="quiet">Name</button>`);
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
    } else if (kind === "cull") {
      // irreversible: the first press arms the button, the second sends
      if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Confirm cull"; return; }
      act("cull", { id: uid }, `cull requested for #${uid}`, btn);
    }
  }

  // ---------- account ----------
  const msg = (id, text, cls = "") => { const m = $(id); m.className = "msg " + cls; m.textContent = text; };
  async function refreshMe() {
    if (!session) return;
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
    $("acct-custodial").hidden = walletMode();
    $("acct-wallet").hidden = !walletMode();
    document.querySelectorAll("#acct-modes button").forEach(b => b.classList.toggle("on", b.dataset.mode === acctMode));
    if (walletMode()) { renderWallet(); return; }
    $("acct-out").hidden = !!session;
    $("acct-in").hidden = !session;
    if (session) refreshMe();
  }
  // ---- wallet mode ----
  function setMode(mode) {
    if (mode === acctMode) return;
    acctMode = mode;
    try { localStorage.setItem("instar_acct_mode", mode); } catch { /* private mode */ }
    renderAcct(); renderWindows(); updateInspector(true);
  }
  document.querySelectorAll("#acct-modes button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
  // The IDL is read once, the first time wallet mode needs it.
  let programLoading = null;
  function ensureProgram() {
    if (program) return Promise.resolve(program);
    return programLoading ??= loadIdl().then(idl => (program = new Program(idl, config))).catch(e => { programLoading = null; throw e; });
  }
  function renderWallet() {
    const on = !!(wallet && wallet.address);
    $("wal-out").hidden = on;
    $("wal-in").hidden = !on;
    if (on) {
      setHud("wal-name", wallet.name);
      setHud("wal-addr", wallet.address);
      setHud("wal-owned", records().filter(l => l.keeper === wallet.address && l.status === STATUS.OWNED).length);
      setHud("wal-rpc", (program && program.endpoints[0]) || config.rpc || "the RPC");
      $("wal-scan").href = explorerLink("address", wallet.address, live);
      return;
    }
    const found = wallets(live.cluster);
    setHtml("wal-list", found.length
      ? found.map(w => `<button data-wallet="${esc(w.name)}">Connect ${esc(w.name)}</button>`).join("")
      : `<span class="note">no Solana wallet is installed in this browser; Phantom, Solflare and Backpack all register themselves here once installed</span>`);
  }
  onWallets(() => { if (walletMode()) renderWallet(); });
  // The wallet window's message line doubles as act()'s .act-msg target, so
  // its class is kept intact when it is written directly.
  const walMsg = (text, cls = "") => { const m = $("wal-msg2"); m.className = "msg act-msg " + cls; m.textContent = text; };
  async function refreshWallet() {
    if (!wallet || !wallet.address || !program) return;
    const who = wallet.address;
    try {
      const [balance, credit] = await Promise.all([program.balance(who), program.credit(who)]);
      if (!wallet || wallet.address !== who) return;
      walletBal = { balance, credit };
      setHud("wal-balance", sol(balance) + " SOL");
      setHud("wal-credit", sol(credit) + " SOL");
      $("wal-claim").hidden = credit === 0n;
      renderMine();
    } catch (e) { walMsg(`the RPC did not answer: ${e.message}`, "err"); }
  }
  // The change listener is kept so a disconnect (ours or the wallet's)
  // removes it; otherwise every reconnect would add another.
  let walletOff = null;
  function dropWallet() {
    if (walletOff) { try { walletOff(); } catch { /* the wallet may already be gone */ } walletOff = null; }
    wallet = null;
  }
  $("wal-list").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-wallet]");
    if (!b) return;
    const w = wallets(live.cluster).find(x => x.name === b.dataset.wallet);
    if (!w) return;
    b.disabled = true; msg("wal-msg", `asking ${w.name}\u2026`);
    try {
      await ensureProgram();
      await w.connect();
      dropWallet();
      wallet = w;
      walletOff = w.onChange((addr) => { if (!addr) dropWallet(); walMsg(""); renderAcct(); renderWindows(); updateInspector(true); refreshWallet(); });
      msg("wal-msg", ""); walMsg("");
      renderAcct(); renderWindows(); updateInspector(true);
      refreshWallet();
    } catch (e) { msg("wal-msg", e.message, "err"); b.disabled = false; }
  });
  $("wal-disconnect").addEventListener("click", async () => {
    const w = wallet; dropWallet();
    try { if (w) await w.disconnect(); } catch { /* the wallet may already be gone */ }
    renderAcct(); renderWindows(); updateInspector(true);
  });
  $("wal-claim").addEventListener("click", (ev) => act("withdraw", {}, "credit claimed", ev.currentTarget));
  function signIn(j) { setSession({ token: j.token, user: j.user, name: j.name, wallet: j.wallet }); msg("acct-msg2", ""); renderAcct(); renderMine(); }
  function signOut() { setSession(null); me = null; msg("acct-msg2", ""); renderAcct(); renderMine(); }
  async function auth(create) {
    const user = $("acct-user").value.trim(), pin = $("acct-pin").value;
    if (!user || !pin) { msg("acct-msg", "name and pin are both needed", "err"); return; }
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
  setInterval(() => { refreshMe(); refreshWallet(); }, 15000);

  // ---------- first person ----------
  const fpBtn = $("btn-fp"), hint = $("hint"), crosshair = $("crosshair");
  fpBtn.addEventListener("click", () => cage.toggleFirstPerson());
  cage.onFpChange = (on) => {
    fpBtn.textContent = on ? "Leave the glass" : "On the glass";
    crosshair.style.display = on && cage.fp.mode === "locked" ? "block" : "none";
    hint.textContent = on
      ? (cage.fp.mode === "locked" ? "A/D to crawl along the pane, W/S to climb \u00b7 mouse to look \u00b7 shift to hurry \u00b7 click to inspect \u00b7 esc to leave" : "A/D to crawl along the pane, W/S to climb \u00b7 hold the mouse to look \u00b7 esc to leave")
      : "drag to orbit \u00b7 wheel to zoom \u00b7 click a fly to inspect \u00b7 double-click to follow it";
  };

  // ---------- journal poll ----------
  const entryKey = (e) => `${e.type}:${e.tick}:${e.uid ?? e.value ?? e.n ?? ""}`;
  const seenEntries = new Set(live.entries.map(entryKey));
  async function poll() {
    const j = await fetchJournal(8000);
    if (!j) return;
    for (const e of j.entries) {
      const k = entryKey(e);
      if (seenEntries.has(k)) continue;
      seenEntries.add(k);
      if (e.type === "cap") pushCage(`<b>capacity</b> becomes ${e.value} at tick ${fmt(e.tick)}`);
      else if (e.type === "cull") pushCage(`<b>cull ordered</b> #${e.uid} at tick ${fmt(e.tick)}`);
      else if (e.type === "provision") pushCage(`<b>provisioned</b> #${e.uid} at tick ${fmt(e.tick)}`);
      else if (e.type === "gen") pushCage(`<b>founders</b> ${e.n} spawn at tick ${fmt(e.tick)}`);
    }
    const lastEpoch = live.epochs.length ? live.epochs[live.epochs.length - 1].epoch : -1;
    for (const ep of j.epochs) if (ep.epoch > lastEpoch) pushChain(`<b>epoch ${ep.epoch} posted</b> ${esc(ep.hash.slice(0, 12))}\u2026 ${txLink(ep.sig)}`);
    Object.assign(live, j);
    renderWindows();
    // the frame loop also refreshes the inspector, but a hidden tab has no
    // frames: a purchase or listing must show up on the next poll regardless
    updateInspector();
  }
  setInterval(poll, 3000);
  pushCage(`<b>joined</b> the world's stream at tick ${fmt(stream.t || live.tick)}`);

  // a #fly=<id> in the address (the NFT's external_url) opens that fly
  {
    const m = location.hash.match(/fly=(\d+)/);
    if (m) {
      const want = +m[1];
      const tryOpen = () => { if (cage.flyById(want)) { cage.select(want); cage.tracking = want; return true; } return false; };
      const iv = setInterval(() => { if (tryOpen() || stream.frames > 30) clearInterval(iv); }, 200);
    }
  }

  // ---------- main loop ----------
  let frame = 0, lastT = performance.now();
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    flies = stream.sample(now);
    cage.render(flies, stream.next ? stream.light : 255, dt);
    frame++;
    setHud("h-tick", fmt(stream.t || live.tick));
    setHud("h-epoch", fmt(Math.floor((stream.t || live.tick) / live.epochInterval)));
    setHud("h-pop", flies.length);
    setHud("h-cap", live.capacity);
    let flying = 0;
    for (const f of flies) if (f.mode === 1) flying++;
    setHud("h-flying", flying);
    const light = stream.light;
    setHud("h-light", stream.next ? `${light > 128 ? "day" : "night"} ${light}` : "\u2014");
    setHud("h-temp", stream.next ? (stream.temp / 100).toFixed(1) + " \u00b0C" : "\u2014");
    setHud("lg-temp", stream.next ? `${((stream.temp - 300) / 100).toFixed(0)}\u2013${((stream.temp + 300) / 100).toFixed(0)} \u00b0C across the cage` : "\u2014");
    {
      let html;
      const v = verifierLine(live);
      if (live.settling === false) html = `<b class="bad">SETTLEMENT PAUSED</b>`;
      else if (stream.state === "lost") html = `<b class="bad">STREAM LOST</b> reconnecting`;
      else if (stream.state === "stalled") html = `<b class="warn">STREAM STALLED</b> no frame for 3 s`;
      else if (stream.state === "reconnecting") html = `<b class="warn">STREAM DROPPED</b> reconnecting`;
      else if (stream.state !== "live") html = `<b class="warn">CONNECTING</b> to the stream`;
      else if (v) html = `<b class="${v.cls}">${v.word}</b> ${esc(v.short)}`;
      else html = `<b>LIVE</b> ${esc(live.cluster)} \u00b7 unverified by this page`;
      setHtml("h-state", html);
    }
    if (frame % 6 === 0) renderBrain();
    if (frame % 10 === 2) updateInspector();
    if (frame % 90 === 5) renderFlies();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  // headless verification: drive one frame without rAF
  window.__instar = { cage, stream, config, journal: live, frame: () => { flies = stream.sample(performance.now()); cage.render(flies, stream.light, 1 / 60); } };
})().catch(e => {
  const b = document.getElementById("boot");
  b.classList.remove("gone");
  b.textContent = "the cage failed to load: " + e.message;
  console.error(e);
});
