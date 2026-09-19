import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.core.ip_extractor import get_real_client_ip_from_headers, pseudonymize_ip, is_private_ip, _parse_ip

def test_cf_connecting():
    headers = {"CF-Connecting-IP": "1.2.3.4"}
    ip = get_real_client_ip_from_headers(headers, "5.6.7.8")
    assert ip == "1.2.3.4"

def test_xff_chain():
    headers = {"X-Forwarded-For": "1.1.1.1, 10.0.0.1, 2.2.2.2"}
    ip = get_real_client_ip_from_headers(headers, "5.6.7.8")
    assert ip == "1.1.1.1"

def test_ipv6_bracket():
    ip_obj = _parse_ip("[2001:db8::1]:8080")
    assert str(ip_obj) == "2001:db8::1"

def test_pseudonymize():
    pseudo = pseudonymize_ip("192.168.1.100")
    assert "xxx" in pseudo or "192.168.1" in pseudo

def test_private():
    assert is_private_ip("192.168.1.1") is True
    assert is_private_ip("8.8.8.8") is False

if __name__ == "__main__":
    test_cf_connecting()
    test_xff_chain()
    test_ipv6_bracket()
    test_pseudonymize()
    test_private()
    print("test_ip OK")
