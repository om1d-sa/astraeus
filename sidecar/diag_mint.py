"""Simulate (eth_call) whether the buyer can self-mint U — no gas, no key needed."""
import os
os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from web3 import Web3
from eth_utils import function_signature_to_4byte_selector

w3 = Web3(Web3.HTTPProvider(os.environ["RPC_URL"]))
TOKEN = Web3.to_checksum_address("0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565")
BUYER = Web3.to_checksum_address("0xC27B72d3a776437f960c94D5923eE94FEa9F03Bc")
AMOUNT = 10 * 10**18  # 10 U


def enc_uint(n):
    return n.to_bytes(32, "big")


def enc_addr(a):
    return bytes(12) + bytes.fromhex(a[2:])


def sim(label, sig, data_args):
    sel = function_signature_to_4byte_selector(sig)
    data = "0x" + (sel + data_args).hex()
    try:
        w3.eth.call({"from": BUYER, "to": TOKEN, "data": data})
        print(f"  OK (would succeed): {label}  [{sig}]")
        return True
    except Exception as e:
        msg = str(e)
        print(f"  REVERT: {label}  [{sig}] -> {msg[:160]}")
        return False


print(f"simulating self-mint of 10 U from buyer {BUYER}\n")
sim("mint(uint256)", "mint(uint256)", enc_uint(AMOUNT))
sim("mint(to=buyer, amount)", "mint(address,uint256)", enc_addr(BUYER) + enc_uint(AMOUNT))
print("\nNote: OK here means the call would not revert if SENT (needs the buyer key + gas).")
