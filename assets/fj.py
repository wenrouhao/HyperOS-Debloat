#!/usr/bin/env python3
"""Reverse-engineered feijipan share downloader."""
import base64, json, time, urllib.parse, urllib.request
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding

KEY = b"dingHao-disk-app"
API = "https://api.feijipan.com"
SHARE_ID = "Z1yMJSjK"


def aes_ecb_encrypt_hex(plaintext: str) -> str:
    """AES-128-ECB, PKCS7, return uppercase hex of ciphertext (matching ciphertext.toString())."""
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
    cipher = Cipher(algorithms.AES(KEY), modes.ECB())
    enc = cipher.encryptor()
    ct = enc.update(padded) + enc.finalize()
    return ct.hex().upper()


def real_now_ms() -> int:
    """Sandbox clock is 2026; real server is 2025. Subtract 365 days."""
    return int(time.time() * 1000) - 365 * 24 * 3600 * 1000


def post(path, params):
    url = API + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="POST", headers={
        "Referer": f"https://share.feijipan.com/s/{SHARE_ID}",
        "Origin": "https://share.feijipan.com",
        "User-Agent": "Mozilla/5.0",
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def signed(extra):
    now = real_now_ms()
    return {
        "shareId": SHARE_ID,
        "timestamp": aes_ecb_encrypt_hex(str(now)),
        "auth": aes_ecb_encrypt_hex(f"{SHARE_ID}|{now}"),
        "devType": 6,
        **extra,
    }


def main():
    for path, extra in [
        ("/ws/share/list", {"type": 0, "offset": 1, "limit": 10}),
        ("/ws/share/account/map", {}),
        ("/ws/share/file/list", {}),
    ]:
        print(f"--- {path} ---")
        try:
            r = post(path, signed(extra))
            print(json.dumps(r, ensure_ascii=False)[:600])
        except Exception as e:
            print("ERR", e)
        print()


if __name__ == "__main__":
    main()
