/**
 * ERC-8004 agent identity (BNB AI Agent SDK standard) via the TWAK CLI.
 *
 * Mints / reads an on-chain agent-identity NFT on BSC so Astraeus has a verifiable
 * on-chain identity — the BNB AI Agent SDK's flagship capability, here through
 * TWAK so it stays self-custody (one wallet, one signer).
 *
 *   register -> twak erc8004 register --chain bsc [--uri ...] [--metadata k=v] --json
 *   show     -> twak erc8004 show <agentId> --chain bsc --json
 */
import { runTwak, asRecord, pickNumber, pickString, truncate } from "./twakCli";

const CHAIN = "bsc";

export interface IdentityResult {
  ok: boolean;
  agentId?: string;
  txHash?: string;
  uri?: string;
  metadata?: Record<string, string>;
  error?: string;
  raw?: string;
}

function readAgentId(obj: Record<string, unknown>): string | undefined {
  const s = pickString(obj, ["agentId", "tokenId", "id"]);
  if (s) return s;
  const n = pickNumber(obj, ["agentId", "tokenId", "id"]);
  return n !== undefined ? String(n) : undefined;
}

/** Mint Astraeus's ERC-8004 identity on BSC. On-chain tx — needs BNB for gas. */
export async function registerIdentity(
  opts: { uri?: string; metadata?: Record<string, string> } = {},
): Promise<IdentityResult> {
  const args = ["erc8004", "register", "--chain", CHAIN, "--json"];
  if (opts.uri) args.push("--uri", opts.uri);
  for (const [k, v] of Object.entries(opts.metadata ?? {})) {
    args.push("--metadata", `${k}=${v}`);
  }
  const { json, raw } = await runTwak(args, { timeoutMs: 180_000 });
  const obj = asRecord(json);
  if (obj.error || obj.errorCode)
    return { ok: false, error: String(obj.error ?? obj.errorCode), raw };
  const agentId = readAgentId(obj);
  const txHash = pickString(obj, ["txHash", "hash", "transactionHash"]);
  if (!agentId && !txHash) {
    return {
      ok: false,
      error: `registration not confirmed: ${truncate(raw, 200)}`,
      raw,
    };
  }
  return { ok: true, agentId, txHash, uri: opts.uri, metadata: opts.metadata };
}

/** Read on-chain state of an existing ERC-8004 identity. */
export async function showIdentity(agentId: string): Promise<IdentityResult> {
  const { json, raw } = await runTwak([
    "erc8004",
    "show",
    agentId,
    "--chain",
    CHAIN,
    "--json",
  ]);
  const obj = asRecord(json);
  if (obj.error || obj.errorCode)
    return { ok: false, error: String(obj.error ?? obj.errorCode), raw };
  const uri = pickString(obj, ["agentURI", "uri", "tokenURI"]);
  return { ok: true, agentId, uri, raw };
}
