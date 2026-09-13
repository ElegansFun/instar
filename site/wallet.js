// wallet.js: the visitor's own Solana wallet. Discovery follows the Wallet
// Standard (the `wallet-standard:app-ready` / `register-wallet` events and
// the older `navigator.wallets` callback list), with a Phantom-style
// `window.solana` provider as the fallback for wallets that only inject
// that. Every wallet is wrapped once in one small shape the page uses:
//   { name, icon, address, connect(), disconnect(), signAndSend(tx, program), onChange(cb) -> unsubscribe }
// where signAndSend returns the base58 signature. The page's own RPC is the
// sender whenever the wallet can sign without sending, so the network can
// never differ from /api/config; a wallet that only signs-and-sends is
// used only when it lists the page's chain. No npm at runtime.
import { base58, isSignature } from "./chain.js";

const CHAIN_ID = { localnet: "solana:localnet", devnet: "solana:devnet", testnet: "solana:testnet", "mainnet-beta": "solana:mainnet" };

const standard = new Map(); // name -> Wallet Standard wallet object
const listeners = new Set();
function notify() { for (const cb of listeners) cb(); }

const registry = {
  register(...wallets) {
    for (const w of wallets) {
      if (!w || !w.name || !w.features || !w.features["standard:connect"]) continue;
      if (!(w.chains || []).some(c => String(c).startsWith("solana:"))) continue;
      standard.set(w.name, w);
    }
    notify();
    return () => { for (const w of wallets) if (w && standard.get(w.name) === w) standard.delete(w.name); notify(); };
  },
};
window.addEventListener("wallet-standard:register-wallet", (ev) => { try { ev.detail(registry); } catch { /* not a wallet */ } });
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry }));
{
  // legacy list: wallets push a callback that receives { register }
  const list = navigator.wallets;
  if (list && typeof list.push === "function") {
    if (Array.isArray(list)) for (const cb of list) { try { cb(registry); } catch { /* ignore */ } }
    const push = list.push.bind(list);
    list.push = (...cbs) => { for (const cb of cbs) { try { cb(registry); } catch { /* ignore */ } } return push(...cbs); };
  }
}

const isSolana = (a) => (a.chains || []).some(c => String(c).startsWith("solana:"));
function signatureOf(v) {
  const sig = typeof v === "string" ? v : v instanceof Uint8Array ? base58(v) : v && v.signature ? signatureOf(v.signature) : null;
  if (!isSignature(sig)) throw new Error("the wallet returned no transaction signature");
  return sig;
}

function wrapStandard(w, cluster) {
  const chain = CHAIN_ID[cluster];
  let account = null;
  const me = {
    name: w.name, icon: w.icon || null, address: null,
    async connect() {
      if (!chain) throw new Error(`this world runs on ${cluster}, which no wallet knows as a chain`);
      const r = await w.features["standard:connect"].connect();
      account = (r.accounts || w.accounts || []).find(isSolana);
      if (!account) throw new Error(`${w.name} offered no Solana account`);
      me.address = account.address;
      return me.address;
    },
    async disconnect() {
      const f = w.features["standard:disconnect"];
      if (f) await f.disconnect();
      account = null; me.address = null;
    },
    async signAndSend(tx, program) {
      const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const st = w.features["solana:signTransaction"];
      if (st) {
        const [out] = await st.signTransaction({ transaction: bytes, account, chain });
        return signatureOf(await program.sendRaw(out.signedTransaction));
      }
      const sas = w.features["solana:signAndSendTransaction"];
      if (!sas) throw new Error(`${w.name} cannot sign transactions`);
      if (!(account.chains || []).includes(chain)) throw new Error(`${w.name} can only send on its own network, not ${cluster}; switch it or use a wallet that signs`);
      const [out] = await sas.signAndSendTransaction({ transaction: bytes, account, chain, options: { preflightCommitment: "confirmed" } });
      return signatureOf(out.signature);
    },
    onChange(cb) {
      const ev = w.features["standard:events"];
      if (!ev) return () => { };
      const off = ev.on("change", (p) => {
        if (!p.accounts) return;
        account = p.accounts.find(isSolana) || null;
        me.address = account ? account.address : null;
        cb(me.address);
      });
      return typeof off === "function" ? off : () => { };
    },
  };
  return me;
}

function wrapProvider(p) {
  const me = {
    name: p.isPhantom ? "Phantom" : p.isSolflare ? "Solflare" : p.isBackpack ? "Backpack" : "Injected wallet", icon: null, address: null,
    async connect() {
      const r = await p.connect();
      const pk = (r && r.publicKey) || p.publicKey;
      if (!pk) throw new Error("the wallet connected without an account");
      me.address = pk.toString();
      return me.address;
    },
    async disconnect() { if (typeof p.disconnect === "function") await p.disconnect(); me.address = null; },
    async signAndSend(tx, program) {
      if (typeof p.signTransaction === "function") {
        const signed = await p.signTransaction(tx);
        return signatureOf(await program.sendRaw(signed.serialize()));
      }
      if (typeof p.signAndSendTransaction !== "function") throw new Error("the wallet cannot sign transactions");
      return signatureOf(await p.signAndSendTransaction(tx, { preflightCommitment: "confirmed" }));
    },
    onChange(cb) {
      if (typeof p.on !== "function") return () => { };
      const onDisconnect = () => { me.address = null; cb(null); };
      const onAccount = (pk) => { me.address = pk ? pk.toString() : null; cb(me.address); };
      p.on("disconnect", onDisconnect);
      p.on("accountChanged", onAccount);
      return () => {
        if (typeof p.off === "function") { p.off("disconnect", onDisconnect); p.off("accountChanged", onAccount); }
        else if (typeof p.removeListener === "function") { p.removeListener("disconnect", onDisconnect); p.removeListener("accountChanged", onAccount); }
      };
    },
  };
  return me;
}

// One wrapper per wallet object for the page's life, so a button rendered
// earlier and the wallet clicked later are the same thing.
const wrapped = new WeakMap();
const wrap = (obj, make) => { let m = wrapped.get(obj); if (!m) { m = make(); wrapped.set(obj, m); } return m; };

// The wallets found right now, Standard ones first. The provider fallback
// is offered only when no Standard wallet claims the page, since Standard
// wallets also inject window.solana and would otherwise appear twice.
export function wallets(cluster) {
  const out = [...standard.values()].map(w => wrap(w, () => wrapStandard(w, cluster)));
  const p = window.solana;
  if (!out.length && p && typeof p.connect === "function") out.push(wrap(p, () => wrapProvider(p)));
  return out;
}
export function onWallets(cb) { listeners.add(cb); return () => listeners.delete(cb); }
