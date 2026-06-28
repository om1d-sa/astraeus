/** A single position held by the agent wallet. */
export interface Holding {
  symbol: string;
  address?: string;
  amount: number;
  valueUsd: number;
}

/** Snapshot of the agent wallet. */
export interface Portfolio {
  totalValueUsd: number;
  /** Stablecoin (cash) leg available to deploy. */
  cashUsd: number;
  holdings: Holding[];
}

export interface SwapRequest {
  fromSymbol: string;
  toSymbol: string;
  amountUsd: number;
  maxSlippageBps: number;
  /**
   * Optional on-chain contract address for the SELL leg's token. When set, the live
   * (TWAK) executor passes the address instead of the (chain-ambiguous) ticker so the
   * aggregator resolves the exact BSC token — symbols like M/B/U/NFT collide across
   * chains. Ignored by the paper executor (which keys holdings by symbol).
   */
  fromAddress?: string;
  /** Optional on-chain contract address for the BUY leg's token (see {@link fromAddress}). */
  toAddress?: string;
}

export interface SwapResult {
  ok: boolean;
  /** On-chain transaction hash (the Track 1 "on-chain proof"). */
  txHash?: string;
  filledUsd?: number;
  error?: string;
}

/**
 * Executor — the EXECUTION seam.
 *
 * The production implementation is backed by the Trust Wallet Agent Kit (TWAK)
 * in Agent Wallet mode: self-custody, local signing, keys never leave the user.
 * It calls TWAK MCP tools (e.g. `twak swap`, `twak wallet portfolio`,
 * `twak compete register`) through `@elizaos/plugin-mcp`.
 *
 * Keeping it behind an interface means the strategy + autonomous loop are
 * exercised in paper-trading mode (a mock executor) before any real funds move.
 */
export interface Executor {
  /** Current agent-wallet portfolio. */
  getPortfolio(): Promise<Portfolio>;
  /** Execute a swap with self-custody signing. */
  swap(req: SwapRequest): Promise<SwapResult>;
  /** Register the agent wallet on-chain for the Track 1 competition (before the trading window opens). */
  registerForCompetition(): Promise<SwapResult>;
}
