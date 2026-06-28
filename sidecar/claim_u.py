"""Claim 10 U from the faucet contract directly (no WalletConnect / no UI).

Sends `requestTokens()` to the faucet FROM the wallet whose key is in
CLIENT_PRIVATE_KEY. The 10 U go to that same address (msg.sender), so set
CLIENT_PRIVATE_KEY to your BUYER key (0xC27B...) first.

Run (buyer terminal, venv active):
    $env:CLIENT_PRIVATE_KEY = "0x<buyer key>"
    python claim_u.py
"""
import os
os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from web3 import Web3
from eth_account import Account

RPC = os.environ["RPC_URL"]
FAUCET = Web3.to_checksum_address("0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3")
TOKEN = Web3.to_checksum_address("0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565")

key = os.environ.get("CLIENT_PRIVATE_KEY")
if not key:
    raise SystemExit("Set CLIENT_PRIVATE_KEY to your buyer key first.")

w3 = Web3(Web3.HTTPProvider(RPC))
acct = Account.from_key(key)
print(f"claiming 10 U to (msg.sender) = {acct.address}")

faucet = w3.eth.contract(address=FAUCET, abi=[
    {"inputs": [], "name": "requestTokens", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
])
erc20 = w3.eth.contract(address=TOKEN, abi=[
    {"inputs": [{"name": "o", "type": "address"}], "name": "balanceOf",
     "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"},
])

before = erc20.functions.balanceOf(acct.address).call()
try:
    gas = int(faucet.functions.requestTokens().estimate_gas({"from": acct.address}) * 1.3)
except Exception:
    gas = 200_000
gas_price = max(int(w3.eth.gas_price * 1.3), 5_000_000_000)  # >=5 gwei floor

tx = faucet.functions.requestTokens().build_transaction({
    "from": acct.address,
    "nonce": w3.eth.get_transaction_count(acct.address),
    "gas": gas,
    "gasPrice": gas_price,
    "chainId": 97,
})
signed = acct.sign_transaction(tx)
raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
h = w3.eth.send_raw_transaction(raw)
print(f"sent: {h.hex()}")
rcpt = w3.eth.wait_for_transaction_receipt(h)
print(f"status: {'SUCCESS' if rcpt.status == 1 else 'FAILED'}  "
      f"explorer: https://testnet.bscscan.com/tx/{h.hex()}")
after = erc20.functions.balanceOf(acct.address).call()
print(f"U balance: {before/1e18} -> {after/1e18}")
