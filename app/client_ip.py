"""
═══ §2 — CLIENT IP RESOLUTION ═══════════════════════════════════════════════
The honest version of what the previous project did.

WHAT THIS SOLVES
    A reverse proxy (nginx / Caddy / Cloudflare / Render) terminates the TCP
    connection, so `request.client.host` is the proxy, not the user. We need
    the real user IP for logging, rate limiting and banning.

WHAT THIS DELIBERATELY DOES NOT CLAIM
    The resolved IP is a *string*. Attaching it to an outbound request does not
    make that request originate from the user's host. The TCP source address of
    every upstream call is this server's IP, always, because the SYN-ACK has to
    come back to us. See `forwarded_headers()` — it documents exactly what
    upstream can and cannot learn from these headers.

THE ONE BUG THIS FILE EXISTS TO KILL
    The previous code did `xff.split(",")[0]` — took the LEFTMOST entry. That is
    the entry the *client* controls. Anyone could claim to be 8.8.8.8 and get a
    fresh rate-limit bucket. Here we only read forwarded headers when the socket
    peer is a proxy we explicitly trust, and we append our own observation on
    the right, which is the standard "first untrusted hop" rule.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Iterable, Optional

from starlette.requests import HTTPConnection

XFF = "x-forwarded-for"
X_REAL_IP = "x-real-ip"
CF_CONNECTING = "cf-connecting-ip"
TRUE_CLIENT_IP = "true-client-ip"
X_CLUSTER_IP = "x-cluster-client-ip"
FORWARDED = "forwarded"

# Ordered by trustworthiness. CF/True-Client-IP are written by Cloudflare after
# it validates the chain, so they beat a raw X-Forwarded-For.
_CANDIDATES = (CF_CONNECTING, TRUE_CLIENT_IP, X_REAL_IP, X_CLUSTER_IP, XFF)


def _clean(ip: str) -> str:
    """Normalise: strip zone id, unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4)."""
    ip = (ip or "").strip().strip("[]")
    if not ip:
        return ""
    if "%" in ip:                                  # fe80::1%eth0
        ip = ip.split("%", 1)[0]
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip                                  # keep odd values (unix socket, "unknown")
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        return str(addr.ipv4_mapped)
    return str(addr)


def socket_peer(conn: HTTPConnection) -> str:
    """The only IP that cannot be forged by the client."""
    try:
        if conn.client is None:
            return ""
    except (AttributeError, AssertionError):
        return ""
    return _clean(conn.client.host or "")


def is_trusted_proxy(peer: str, trusted: Iterable[str]) -> bool:
    if not peer:
        return False
    for entry in trusted:
        entry = (entry or "").strip()
        if not entry:
            continue
        if "/" in entry:                            # CIDR block
            try:
                if ipaddress.ip_address(peer) in ipaddress.ip_network(entry, strict=False):
                    return True
            except ValueError:
                continue
        elif _clean(entry) == peer:
            return True
    return False


def _forwarded_chain(conn: HTTPConnection) -> list[str]:
    """IPs the front proxy reported, most trustworthy header first."""
    found: list[str] = []
    for name in _CANDIDATES:
        raw = conn.headers.get(name)
        if not raw:
            continue
        for part in raw.split(","):
            part = part.strip()
            if name == FORWARDED:                   # for=1.2.3.4;by=x;proto=https
                for token in part.split(";"):
                    key, _, val = token.strip().partition("=")
                    if key.strip().lower() == "for":
                        part = val.strip().strip('"')
                        break
            part = _clean(part)
            if part and part.lower() != "unknown" and part not in found:
                found.append(part)
    return found


@dataclass(frozen=True)
class ClientInfo:
    ip: str                    # best guess at who to attribute this request to
    peer: str                  # who actually opened the socket (unforgeable)
    chain: tuple[str, ...]    # what proxies claimed, in order
    from_proxy: bool          # was a forwarded header believed at all?
    spoofable: bool           # True => the client could have chosen `ip`

    @property
    def label(self) -> str:
        tag = "proxied" if self.from_proxy else ("direct" if self.peer else "unknown")
        if self.spoofable:
            tag += "+unverified"
        return f"{self.ip or '?'} ({tag})"


def resolve(
    conn: HTTPConnection,
    *,
    trusted_proxies: Iterable[str] = (),
    trust_all: bool = False,
) -> ClientInfo:
    """
    Decide who this request belongs to.

    trust_all=True disables the proxy check — which is precisely the bug the
    previous project shipped. Only reach for it if you are certain nothing sits
    between the browser and this process, and expect the limiter to be moot.
    """
    peer = socket_peer(conn)
    chain = _forwarded_chain(conn)

    if not chain:
        return ClientInfo(peer, peer, (), False, False)

    # The trust decision is made FIRST, on the socket. Never let the presence
    # of a header bypass it — an earlier version returned early when `peer`
    # was falsy, which meant any server whose ASGI `client` tuple reports the
    # *peer* address (uvicorn does) skipped the check entirely and handed the
    # client a fresh bucket per fake IP.
    believable = trust_all or (peer != "" and is_trusted_proxy(peer, trusted_proxies))
    if not believable:
        # A client on a direct connection stuffed the headers full of IPs.
        # Ignore every one of them; attribute by the socket alone.
        return ClientInfo(peer, peer, tuple(chain), False, True)

    if chain[0] == peer:
        # Uvicorn's proxy_headers rewrites request.client.host from XFF for
        # requests coming from FORWARDED_ALLOW_IPS — so a request from
        # localhost makes peer *and* chain[0] equal the claimed IP. There is
        # no independent socket evidence left; the claim is unverifiable.
        # Treat it as direct: attribute the address, flag it, and let the
        # caller decide whether that is good enough.
        return ClientInfo(peer, peer, tuple(chain), False, True)

    return ClientInfo(chain[0], peer, tuple(chain), True, False)


def forwarded_headers(
    info: Optional[ClientInfo], *, enabled: bool = True
) -> dict[str, str]:
    """
    Headers we attach to the OUTBOUND upstream request.

    ┌───────────────────────────────────────────────────────────────────────┐
    │ READ THIS BEFORE DEPENDING ON IT                                      │
    │                                                                       │
    │ These are self-reported metadata. They tell the upstream service      │
    │ "we believe a human at this IP triggered this". A well-behaved        │
    │ backend that trusts this proxy may then bill/rate-limit that IP.       │
    │                                                                       │
    │ They do NOT change the TCP source address. Upstream's socket always   │
    │ sees this server. There is no header, library or trick that changes    │
    │ that for an ordinary client-server request, because the upstream's     │
    │ reply packets must be routable back to whoever opened the socket.      │
    │                                                                       │
    │ Appending the existing chain (rather than replacing it, as the old     │
    │ code did) keeps the audit trail intact so upstream can apply the       │
    │ first-untrusted-hop rule itself instead of taking our word for it.     │
    └───────────────────────────────────────────────────────────────────────┘
    """
    if not enabled or info is None or not info.ip:
        return {}

    existing = [p for p in info.chain if p and p != info.ip]
    chain = [info.ip, *existing]

    headers = {
        XFF: ", ".join(chain),
        X_REAL_IP: info.ip,
        FORWARDED: f'for={info.ip};by=unknown;proto=https;host=unknown',
    }
    return headers


def audit_line(info: Optional[ClientInfo]) -> str:
    if info is None:
        return "ip=-"
    parts = [f"ip={info.ip or '-'}", f"peer={info.peer or '-'}"]
    if info.chain:
        parts.append(f"claimed={'>'.join(info.chain)}")
    if info.from_proxy:
        parts.append("via=trusted-proxy")
    elif info.spoofable:
        parts.append("via=direct(headers-ignored)")
    return " ".join(parts)
