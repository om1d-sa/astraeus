"""Inspect the U faucet contract and simulate requestTokens() from the buyer."""
import os
os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from web3 import Web3

w3 = Web3(Web3.HTTPProvider(os.environ["RPC_URL"]))
FAUCET = Web3.to_checksum_address("0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3")
BUYER = Web3.to_checksum_address("0xC27B72d3a776437f960c94D5923eE94FEa9F03Bc")

abi = [
    {"inputs": [{"name": "_address", "type": "address"}], "name": "allowedToWithdraw",
     "outputs": [{"name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "requestTokens", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [], "name": "tokenAmount", "outputs": [{"name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "tokenInstance", "outputs": [{"name": "", "type": "address"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "waitTime", "outputs": [{"name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
]
f = w3.eth.contract(address=FAUCET, abi=abi)

print(f"faucet         = {FAUCET}")
print(f"tokenInstance  = {f.functions.tokenInstance().call()}")
amt = f.functions.tokenAmount().call()
print(f"tokenAmount    = {amt / 1e18} U per claim")
print(f"waitTime       = {f.functions.waitTime().call()} s (cooldown between claims)")
print(f"allowedToWithdraw(buyer) = {f.functions.allowedToWithdraw(BUYER).call()}")

print("\nsimulating requestTokens() from buyer (eth_call):")
try:
    data = f.encode_abi("requestTokens", [])
    w3.eth.call({"from": BUYER, "to": FAUCET, "data": data})
    print("  OK -> requestTokens() would SUCCEED if sent from the buyer wallet.")
except Exception as e:
    print(f"  REVERT -> {str(e)[:200]}")
