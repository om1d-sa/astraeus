"""Resolve the U-token proxy implementation and probe IT for a public faucet/mint."""
import os
os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from web3 import Web3
from eth_utils import function_signature_to_4byte_selector

w3 = Web3(Web3.HTTPProvider(os.environ["RPC_URL"]))
TOKEN = Web3.to_checksum_address("0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565")

# EIP-1967 implementation slot
SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
raw = w3.eth.get_storage_at(TOKEN, SLOT)
impl = Web3.to_checksum_address("0x" + raw.hex()[-40:])
print(f"proxy {TOKEN}\nimpl  {impl}\n")

code = w3.eth.get_code(impl).hex()
print(f"impl bytecode length = {len(code)} chars\n")

candidates = [
    "mint(address,uint256)", "mint(uint256)", "mint()", "mint(address)",
    "claim()", "claim(uint256)", "claim(address)", "claimTokens()",
    "faucet()", "faucet(address)", "faucet(uint256)",
    "drip()", "drip(address)", "requestTokens()", "requestTokens(address)",
    "getTokens()", "gimme()", "freeMint()", "freeMint(uint256)",
    "mintTo(address,uint256)", "dripTo(address)", "give(address)",
]
print("present  selector    signature")
for sig in candidates:
    sel = function_signature_to_4byte_selector(sig).hex()
    mark = "  YES  " if sel in code else "   -   "
    print(f"{mark}  0x{sel}  {sig}")
