"""
Print the sidecar's ERC-8183 wallet address — the receive address to fund with
test BNB. Creates/loads the wallet from ~/.bnbagent/ using WALLET_PASSWORD (no
server needed).

Usage (from the sidecar/ folder, venv activated, after setting WALLET_PASSWORD):
    python show_address.py
"""

import os
from pathlib import Path


def _load_env(path: Path) -> None:
    """Minimal .env loader (avoids an extra dependency)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def _wallet_address(wallet) -> str | None:
    """The exact attribute varies by SDK version — try the common ones."""
    for attr in ("address", "public_address"):
        val = getattr(wallet, attr, None)
        if isinstance(val, str) and val.startswith("0x"):
            return val
    account = getattr(wallet, "account", None)
    if account is not None:
        val = getattr(account, "address", None)
        if isinstance(val, str) and val.startswith("0x"):
            return val
    return None


def main() -> None:
    _load_env(Path(__file__).resolve().parent / ".env")
    password = os.getenv("WALLET_PASSWORD")
    if not password:
        raise SystemExit("Set WALLET_PASSWORD in sidecar/.env first.")

    # Imported here so a missing-dependency error is obvious.
    from bnbagent.wallets import EVMWalletProvider

    private_key = os.getenv("PRIVATE_KEY") or None
    wallet = (
        EVMWalletProvider(password=password, private_key=private_key)
        if private_key
        else EVMWalletProvider(password=password)
    )

    address = _wallet_address(wallet)
    if address:
        print(f"Sidecar wallet address: {address}")
        print("Fund with test BNB at: https://testnet.bnbchain.org/faucet-smart")
    else:
        print("Wallet ready, but the address attribute differs on this SDK version.")
        print("Start the server and GET http://localhost:8183/erc8183/status to read it.")


if __name__ == "__main__":
    main()
