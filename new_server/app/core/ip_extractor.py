from __future__ import annotations
import ipaddress
from typing import Optional, Dict

def _parse_ip(s: str):
    """Returns ipaddress object or None; handles [ipv6]:port"""
    if not s:
        return None
    s = s.strip()
    if s.startswith("["):
        try:
            # [2001:db8::1]:8080 -> 2001:db8::1
            inner = s.split("]")[0][1:]
            s = inner
        except:
            pass
    else:
        # ipv4:port -> ipv4 if valid ip
        if ":" in s and s.count(":") == 1 and "." in s:
            try:
                possible_ip = s.split(":")[0]
                ipaddress.ip_address(possible_ip)
                s = possible_ip
            except:
                pass
    s = s.strip()
    try:
        return ipaddress.ip_address(s)
    except ValueError:
        return None

def _parse_ip_str(s: str) -> Optional[str]:
    """Returns string IP or None"""
    obj = _parse_ip(s)
    return str(obj) if obj else None

def get_real_client_ip_from_headers(headers: Dict[str, str], client_host: Optional[str] = None) -> str:
    lower = {k.lower(): v for k, v in headers.items()}
    # Cloudflare
    cf = lower.get("cf-connecting-ip")
    if cf and _parse_ip(cf):
        return cf.strip()
    true_ip = lower.get("true-client-ip")
    if true_ip and _parse_ip(true_ip):
        return true_ip.strip()
    x_real = lower.get("x-real-ip")
    if x_real and _parse_ip(x_real):
        return x_real.strip()
    xff = lower.get("x-forwarded-for")
    if xff:
        cands = [c.strip() for c in xff.split(",") if c.strip()]
        for cand in cands:
            ip = _parse_ip(cand)
            if ip and not ip.is_private and not ip.is_loopback and not ip.is_multicast:
                return str(ip)
        if cands:
            return cands[0]
    if client_host:
        ip = _parse_ip(client_host)
        if ip:
            return str(ip)
        return client_host
    return "unknown"

def get_real_client_ip(request) -> str:
    headers = dict(request.headers)
    client_host = request.client.host if request.client else None
    return get_real_client_ip_from_headers(headers, client_host)

def pseudonymize_ip(ip: str) -> str:
    parsed = _parse_ip(ip)
    if not parsed:
        return "xxx.xxx.xxx.xxx"
    if isinstance(parsed, ipaddress.IPv4Address):
        parts = str(parsed).split(".")
        return f"{parts[0]}.{parts[1]}.{parts[2]}.xxx"
    else:
        hextets = str(parsed).split(":")
        if len(hextets) >= 4:
            return ":".join(hextets[:4]) + ":xxxx:xxxx:xxxx:xxxx"
        return "xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx"

def is_private_ip(ip: str) -> bool:
    parsed = _parse_ip(ip)
    if not parsed:
        return False
    return parsed.is_private or parsed.is_loopback
