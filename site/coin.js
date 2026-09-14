// coin.html: the coin named by the world's config, the treasuries and every
// fee transaction from the journal. Nothing is typed in.
import { boot, fetchJournal, API } from "./engine.js";
import { explorerLink, sol, short, esc, fmt } from "./api.js";

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = String(v); };
const setHtml = (id, html) => { const el = $(id); if (el && el.innerHTML !== html) el.innerHTML = html; };
const link = (kind, value, src, n = 8) => value ? `<a class="chain" href="${esc(explorerLink(kind, value, src))}" target="_blank" rel="noopener">${esc(value.length > 2 * n + 1 ? short(value, n) : value)}</a>` : "\u2014";

(async function main() {
  const { journal, config } = await boot({});
  const live = journal;
  if (!live) {
    setHtml("lv-coin", `<b class="bad">NO WORLD</b> ${esc(API ? "nothing answers at " + API : "this page must be served by the world process")}`);
    setTimeout(main, 5000);
    return;
  }
  const coin = config.coin || {};
  if (coin.mint) {
    const a = $("cta-pump");
    a.href = `https://pump.fun/coin/${encodeURIComponent(coin.mint)}`;
    a.target = "_blank"; a.rel = "noopener"; a.hidden = false;
  }
  setHtml("coin-mint", coin.mint ? `${link("address", coin.mint, live, 44)} \u00b7 <a class="chain" href="https://pump.fun/coin/${esc(coin.mint)}" target="_blank" rel="noopener">pump.fun</a>` : `<span class="faint">not launched yet; the world will name it here when it is</span>`);
  setHtml("coin-creator", coin.creator ? link("address", coin.creator, live, 44) : `<span class="faint">no fee keypair configured on this world</span>`);

  function render() {
    setText("lv-metab", sol(live.metabolism));
    setText("lv-pool", sol(live.pool));
    setText("lv-cap", live.capacity);
    const fees = (live.txlog || []).filter(t => (t.kind === "claim-fees" || t.kind === "fees") && t.ok !== false);
    setText("lv-claims", fmt(fees.filter(t => t.kind === "fees").length));
    setHtml("lv-coin", coin.mint
      ? `<b>$INSTAR</b> ${link("address", coin.mint, live)} on ${esc(live.cluster)} \u00b7 creator ${link("address", coin.creator, live)}`
      : `<b>NOT LAUNCHED</b> the cage runs on births and resales; the fee keypair${coin.creator ? ` ${link("address", coin.creator, live)}` : ""} is swept regardless`);
    const rows = fees.slice(-24).reverse();
    setHtml("claims-table", `<thead><tr><th>When</th><th>Kind</th><th>Signature</th></tr></thead><tbody>${rows.length
      ? rows.map(t => `<tr><td>${new Date(t.t).toISOString().replace("T", " ").slice(0, 19)}</td><td>${esc(t.kind)}</td><td>${link("tx", t.sig, live, 12)}</td></tr>`).join("")
      : `<tr><td colspan="3" class="faint">no claim or sweep has been recorded on this world yet</td></tr>`}</tbody>`);
  }
  render();
  setInterval(async () => {
    const j = await fetchJournal(8000);
    if (!j) return;
    Object.assign(live, j);
    render();
  }, 5000);
})().catch(e => {
  setHtml("lv-coin", `<b class="bad">FAILED</b> ${esc(e.message)}`);
  console.error(e);
});
