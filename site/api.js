// World API client: session token, JSON calls, explorer links, money formatting.
import { API, SAME_ORIGIN_API } from "./engine.js";

// The session is a bearer token for the world that served this page. It is
// never read, stored or sent when the API is any other origin.
const SESSION_KEY = "instar_session";
export let session = null;
if (SAME_ORIGIN_API) {
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; }
}

export function setSession(s) {
  if (!SAME_ORIGIN_API) return;
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private mode: the session lives for this page only */ }
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(method, path, body) {
  if (!API) throw new ApiError("no world is reachable from this page", 0);
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (SAME_ORIGIN_API && session && session.token) headers.authorization = "Bearer " + session.token;
  let r;
  try {
    r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("the world is unreachable", 0);
  }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok) throw new ApiError((j && j.error) || (r.status + " " + r.statusText), r.status);
  return j;
}
export const post = (path, body = {}) => call("POST", path, body);

// https://explorer.solana.com/{tx|address}/{x}?cluster=... ; the world tells
// us the query so localnet (custom rpc) and devnet both link correctly.
export function explorerLink(kind, value, src) {
  const base = (src && src.explorer) || "https://explorer.solana.com";
  const q = (src && src.explorerQuery !== undefined) ? src.explorerQuery
    : (src && src.cluster && src.cluster !== "mainnet-beta") ? "?cluster=" + src.cluster : "";
  return `${base}/${kind}/${value}${q}`;
}

export const LAMPORTS = 1_000_000_000;
export const lamports = (v) => (typeof v === "bigint") ? Number(v) : Number(v || 0);
// SOL at the precision the reader needs: 4 places for a balance, and for
// dust nothing rounds to a misleading zero. A price is a purchase control
// and is always shown to the lamport: price().
export function sol(v, places = 4) {
  const n = lamports(v) / LAMPORTS;
  if (n === 0) return "0";
  if (Math.abs(n) < Math.pow(10, -places)) return n.toFixed(9).replace(/0+$/, "");
  return n.toFixed(places).replace(/\.?0+$/, "");
}
export const price = (v) => sol(v, 9);
export const short = (s, n = 4) => s ? `${s.slice(0, n)}\u2026${s.slice(-n)}` : "";
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const fmt = (n) => Number(n || 0).toLocaleString("en-US");
export const STATUS = { NONE: 0, OFFERED: 1, OWNED: 2, WILD: 3, DEAD: 4 };
export const STATUS_NAME = ["none", "offered", "owned", "wild", "dead"];
