import ipaddress as ip

NETS = [
    "127.0.0.0/8",
    "100.64.0.0/10",
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/12",
    "172.64.0.0/13",
    "131.0.72.0/22",
]
nets = [ip.ip_network(n) for n in NETS]

TESTS = {
    "104.28.154.249": "Cloudflare WARP (assistant)",
    "78.177.162.54":  "your Turkish home IP (recent login)",
    "100.127.210.57": "Tailscale atlas (your overlay)",
    "112.215.145.47": "unknown IP that logged in as root earlier",
    "45.148.10.183":  "random brute-force attacker (should NOT be whitelisted)",
}

for addr, note in TESTS.items():
    a = ip.ip_address(addr)
    hit = next((str(n) for n in nets if a in n), None)
    tag = f"whitelisted via {hit}" if hit else "NOT whitelisted"
    print(f"  {addr:<17} {tag:<40} ({note})")
