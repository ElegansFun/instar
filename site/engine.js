// The world as this page sees it: the journal (chain record, epochs,
// operator state), the config (chain identity, arena, role groups), and the
// on-demand verifier that replays one epoch in a Web Worker and compares
// the hash with the journal and the World account on chain. The page draws
// from /api/stream (stream.js); no engine runs here unless a visitor asks.
import { ROLE_LABEL } from "./roles.js";

const params = new URLSearchParams(location.search);
// Served by the world process the API is same-origin and nothing else may
// name it: a foreign ?api= would receive this page's session token. Served
// from the repo by a plain static server (dev) the page lives under /site/,
// has no API of its own, and ?api= may point at one.
export const API = location.pathname.startsWith("/site/") ? params.get("api") : location.origin;
export const SAME_ORIGIN_API = API === location.origin;

export const DEATH_CAUSE = { 1: "starved", 2: "senescence", 3: "killed", 4: "desiccated", 5: "drowned", 6: "culled", 7: "exhausted" };
export const CENSUS_HEADER_URL = "/data/canonical/male-cns-v1.0.census.json";
export const CBG_URL = "/data/canonical/male-cns-v1.0.census.cbg";
export const NODES_URL = "/data/canonical/male-cns-v1.0.nodes.json";
export const WASM_URL = "./instar_sim.wasm";

// Fetch the journal; null when no world answers.
export async function fetchJournal(timeoutMs = 2500) {
  if (!API) return null;
  try {
    const r = await fetch(API + "/api/journal", { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.name === "instar" ? j : null;
  } catch { return null; }
}
export async function fetchConfig() {
  if (!API) return {};
  try {
    const r = await fetch(API + "/api/config", { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}
// Boot asks three times with a patient timeout before calling the world
// absent: a first byte delayed by a snapshot being gzipped is not an outage.
export async function boot({ status = () => {} } = {}) {
  status("reading the world's journal");
  let journal = null;
  for (let i = 0; i < 3 && !journal; i++) {
    journal = await fetchJournal(6000);
    if (!journal && API) await new Promise(r => setTimeout(r, 500));
  }
  const config = journal ? await fetchConfig() : {};
  return { journal, config };
}

// The chain keeps only the newest epoch's hash on the World account.
// Offsets come from /api/config, computed from the IDL.
export async function readWorldAccount(config) {
  const w = config.world;
  if (!config.rpc || !w) throw new Error("the world did not publish its account layout");
  const r = await fetch(config.rpc, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [w.account, { encoding: "base64", commitment: "confirmed" }] }),
  });
  if (!r.ok) throw new Error("rpc " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  if (!j.result || !j.result.value) throw new Error("World account not found on this cluster");
  const bytes = Uint8Array.from(atob(j.result.value.data[0]), c => c.charCodeAt(0));
  const dv = new DataView(bytes.buffer);
  const u64 = (f) => Number(dv.getBigUint64(f.offset, true));
  const hash = bytes.subarray(w.lastStateHash.offset, w.lastStateHash.offset + w.lastStateHash.size);
  const hex = (b) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  // the engine's u64 sits big-endian in the last 8 bytes; the rest is zero
  return { at: Date.now(), epoch: u64(w.lastEpoch), tick: u64(w.lastEpochTick), hash32: hex(hash), hash: hex(hash.subarray(hash.length - 8)) };
}

// What the page can honestly say about verification without running
// anything: the CLI verifier's last posted result, if the operator ran it.
export function verifierLine(journal) {
  const v = journal && journal.verifier;
  if (!v || !v.at) return null;
  const when = new Date(v.at);
  const date = isNaN(when) ? String(v.at) : when.toISOString().slice(0, 10);
  const ok = v.verdict === "VERIFIED";
  return {
    cls: ok ? "ok" : "bad",
    word: ok ? "VERIFIED" : "MISMATCH",
    detail: `by the CLI verifier on ${date}, ${v.epochs} epoch${v.epochs === 1 ? "" : "s"}` + (ok ? "" : ` (epoch ${v.epoch} differs)`),
    epoch: v.epoch, hash: v.hash, sig: v.sig, at: v.at,
  };
}

// The desktop-only replay. Runs site/verify-worker.js, which loads the
// canonical graph, the engine and the world's snapshot, replays to the
// next posted epoch and hashes; this side compares the hash with the
// journal and with the World account. Progress lines go to `status`.
export const VERIFY_MEMORY_GB = 0.7;
export function canVerifyHere() {
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return false;
  const mem = navigator.deviceMemory;
  if (mem !== undefined && mem < 2) return false;
  return window.innerWidth > 900 && !/Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
}
export function verifyEpochHere({ journal, config, status = () => {} }) {
  return new Promise((resolve, reject) => {
    const w = new Worker("./verify-worker.js", { type: "module" });
    w.onmessage = async (ev) => {
      const m = ev.data;
      if (m.type === "status") { status(m.text); return; }
      if (m.type === "error") { w.terminate(); reject(new Error(m.text)); return; }
      if (m.type !== "done") return;
      w.terminate();
      const posted = journal.epochs.find(e => e.epoch === m.epoch);
      const result = { epoch: m.epoch, tick: m.tick, local: m.hash, snapshotTick: m.snapshotTick, ticks: m.ticks, ms: m.ms, journal: posted ? posted.hash === m.hash : null, posted, chain: null, onChain: null, chainError: null };
      try {
        const c = await readWorldAccount(config);
        if (c.epoch === m.epoch) { result.onChain = c.hash; result.chain = c.hash === m.hash; }
        else result.chainError = c.epoch > m.epoch ? `the chain has moved on to epoch ${c.epoch}` : `epoch ${m.epoch} is not posted yet (chain at ${c.epoch})`;
      } catch (e) { result.chainError = e.message; }
      resolve(result);
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "the verifier worker failed")); };
    w.postMessage({ api: API, cbg: CBG_URL, nodes: NODES_URL, wasm: WASM_URL, journal: { entries: journal.entries, epochs: journal.epochs, epochInterval: journal.epochInterval, seed: journal.seed } });
  });
}

// Fill every <span data-n="..."> in the page from the config and the
// journal, so no count or rate is typed into the HTML.
export function fillConstants(config, journal) {
  const arena = config.arena || {};
  const v = {
    nodes: config.nodes, edges: config.edges, tickrate: journal ? journal.tickrate : config.tickrate,
    epoch: journal ? journal.epochInterval : config.epochInterval, grid: arena.floor, layers: arena.layers,
    maxpop: config.maxPop, dishes: arena.dishes ? arena.dishes.filter(d => d.kind !== "water").length : undefined,
    roles: config.roleCounts ? Object.keys(config.roleCounts).filter(k => +k !== 0).length : undefined,
    assigned: config.roleCounts ? Object.entries(config.roleCounts).reduce((a, [k, n]) => a + (+k === 0 ? 0 : n), 0) : undefined,
  };
  if (config.roleCounts) for (const [k, n] of Object.entries(config.roleCounts)) v["role" + k] = n;
  for (const el of document.querySelectorAll("[data-n]")) {
    const n = v[el.dataset.n];
    if (n !== undefined) el.textContent = Number(n).toLocaleString("en-US");
  }
  for (const el of document.querySelectorAll("[data-role-label]")) el.textContent = ROLE_LABEL[+el.dataset.roleLabel] || el.dataset.roleLabel;
}
