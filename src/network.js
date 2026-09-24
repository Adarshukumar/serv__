/**
 * network.js — network log + egress IP discovery.
 *
 * Deliberately independent of credential /connect:
 *   - probes THIS machine's public IP (direct sockets, no proxy)
 *   - records a ring-buffer log the UI can read
 *   - every outbound Upstage call appends a line with the egress IP
 *
 *   GET /api/network  → { interfaces, egress, log[], targets }
 */
import os from 'node:os';
import { apiBase, consoleUrl } from './config.js';

/** @type {{t:string, event:string, detail:any}[]} */
const LOG = [];
const MAX = 200;

export function netLog(event, detail = {}) {
  const entry = {
    t: new Date().toISOString(),
    event,
    detail,
  };
  LOG.push(entry);
  if (LOG.length > MAX) LOG.shift();
  const flat = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`[net ${entry.t}] ${event} ${flat}`);
  return entry;
}

export function netLogTail(n = 50) {
  return LOG.slice(-n);
}

/** Local non-internal interfaces (IPv4 + IPv6). */
export function localInterfaces() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      out.push({
        iface: name,
        address: a.address,
        family: a.family === 4 || a.family === 'IPv4' ? 'IPv4' : 'IPv6',
        internal: Boolean(a.internal),
      });
    }
  }
  return out;
}

let _egressCache = null; // { ip, via, at }

/**
 * Probe public egress IP. Direct fetch from THIS process — the same
 * source IP Upstage will see. Never calls /connect or touches creds.
 */
export async function egressIP({ force = false } = {}) {
  if (
    !force &&
    _egressCache &&
    Date.now() - Date.parse(_egressCache.at) < 60_000
  ) {
    return _egressCache;
  }

  const endpoints = [
    'https://api.ipify.org?format=json',
    'https://icanhazip.com/',
    'https://checkip.amazonaws.com/',
    'https://ifconfig.me/ip',
  ];

  for (const url of endpoints) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { 'user-agent': 'upstage-solar-npm' },
      });
      clearTimeout(t);
      if (!r.ok) continue;
      const text = (await r.text()).trim();
      let ip = null;
      try {
        const j = JSON.parse(text);
        ip = j.ip || null;
      } catch {
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text) || text.includes(':')) {
          ip = text;
        }
      }
      if (ip) {
        _egressCache = { ip, via: url, at: new Date().toISOString() };
        netLog('egress-ip', { ip, via: url, note: 'direct from this process = Upstage source IP' });
        return _egressCache;
      }
    } catch {
      /* next */
    }
  }

  const fail = {
    ip: null,
    via: null,
    at: new Date().toISOString(),
    error: 'egress probe unreachable',
  };
  _egressCache = fail;
  netLog('egress-ip-fail', {
    error: fail.error,
    note: 'IP-echo sites blocked here; Upstage calls still open direct sockets from this host',
  });
  return fail;
}

/** Build the full /api/network payload (no credential connect). */
export async function networkReport({ force = false } = {}) {
  const egress = await egressIP({ force });
  const ifaces = localInterfaces();
  const report = {
    at: new Date().toISOString(),
    // what Upstage sees as your source address
    egress,
    // machine-local addresses (never a "server relay")
    interfaces: ifaces.filter((i) => !i.internal).concat(ifaces.filter((i) => i.internal)),
    targets: {
      console: consoleUrl(),
      completions: apiBase(),
    },
    path: {
      browser: '→ this process (loopback UI)',
      outbound: '→ console + apistage DIRECT (source = egress.ip above)',
      relay: 'none',
      proxy_env: 'cleared at startup (HTTP(S)_PROXY deleted, NO_PROXY=*)',
    },
    log: netLogTail(80),
  };
  return report;
}

/** Called right before each Upstage POST so the log shows real source IP. */
export async function logOutbound(target) {
  const e = await egressIP();
  netLog('outbound', {
    target,
    source_ip: e.ip || 'unknown (probe blocked)',
    via: e.via || 'direct-socket',
    relay: 'none',
  });
}
