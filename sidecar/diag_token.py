"""Probe the U token for a public faucet/mint function by selector presence in bytecode."""
import os
os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from web3 import Web3
from eth_utils import function_signature_to_4byte_selector

RPC = os.environ["RPC_URL"]
TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"

w3 = Web3(Web3.HTTPProvider(RPC))
code = w3.eth.get_code(Web3.to_checksum_address(TOKEN)).hex()
print(f"bytecode length = {len(code)} chars (proxy if very short)\n")

candidates = [
    "mint(address,uint256)", "mint(uint256)", "mint()", "mint(address)",
    "claim()", "claim(uint256)", "claim(address)",
    "faucet()", "faucet(address)", "faucet(uint256)",
    "drip()", "drip(address)",
    "requestTokens()", "requestTokens(address)", "getTokens()",
    "gimme()", "gimme(uint256)", "freeMint()", "freeMint(uint256)",
    "mintTo(address,uint256)",
]
print("present  selector    signature")
for sig in candidates:
    sel = function_signature_to_4byte_selector(sig).hex()
    present = sel in code
    mark = "  YES  " if present else "   -   "
    print(f"{mark}  0x{sel}  {sig}")
