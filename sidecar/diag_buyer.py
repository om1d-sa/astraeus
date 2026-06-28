"""Read-only: confirm the real buyer wallet has tBNB (gas) AND U token (payment)."""
import os
os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from bnbagent.erc8183 import ERC8183Client

BUYER = "0xC27B72d3a776437f960c94D5923eE94FEa9F03Bc"
NEW   = "0x0415d7Ef6Ac5b4ada2b2e0eE45511A4521A76bC0"

c = ERC8183Client(None, network="bsc-testnet")
w3 = c.commerce.w3
token = c.commerce.payment_token()
dec = c.token_decimals()
print(f"payment token (U) = {token}  decimals={dec}\n")

# minimal ERC20 balanceOf
erc20 = w3.eth.contract(
    address=w3.to_checksum_address(token),
    abi=[{"constant": True, "inputs": [{"name": "o", "type": "address"}],
          "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}],
          "stateMutability": "view", "type": "function"}],
)
for label, addr in (("REAL funded buyer", BUYER), ("new throwaway", NEW)):
    a = w3.to_checksum_address(addr)
    bnb = w3.eth.get_balance(a) / 1e18
    u = erc20.functions.balanceOf(a).call() / (10 ** dec)
    print(f"{label:18} {a}")
    print(f"    tBNB = {bnb:.6f}   U = {u}\n")
