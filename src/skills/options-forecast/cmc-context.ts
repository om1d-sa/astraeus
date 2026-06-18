import { type IAgentRuntime, logger } from '@elizaos/core';
import { McpService } from '@elizaos/plugin-mcp';

const CMC_SERVER = 'cmc-skill-hub';

type McpLike = {
  callTool(
    server: string,
    tool: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }>;
};

/**
 * Optional CoinMarketCap options-positioning enrichment for a forecast.
 *
 * Pulls `analyze_iv_term_structure` + `analyze_skew_and_smile` for the asset
 * (proxy reads) via the CMC Skill Hub MCP, returning a text blob to add to the
 * forecast prompt. Only call this when the user opts in ("cmc") — it is slower.
 * Returns undefined if the MCP service is unavailable or both skills error.
 */
export async function fetchCmcOptionsContext(
  runtime: IAgentRuntime,
  asset: string,
): Promise<string | undefined> {
  const mcp = runtime.getService(McpService.serviceType) as unknown as McpLike | null;
  if (!mcp) {
    logger.warn('CMC options context requested but MCP service is unavailable');
    return undefined;
  }
  const toText = (r: { content?: Array<{ text?: string }> }) =>
    (r.content ?? []).map((c) => c.text ?? '').join('\n').trim();
  try {
    const [iv, skew] = await Promise.all([
      mcp.callTool(CMC_SERVER, 'execute_skill', {
        unique_name: 'analyze_iv_term_structure',
        parameters: { symbol: asset },
      }),
      mcp.callTool(CMC_SERVER, 'execute_skill', {
        unique_name: 'analyze_skew_and_smile',
        parameters: { symbol: asset },
      }),
    ]);
    const parts: string[] = [];
    if (!iv.isError) parts.push(`IV term structure: ${toText(iv).slice(0, 1200)}`);
    if (!skew.isError) parts.push(`Skew & smile: ${toText(skew).slice(0, 1200)}`);
    return parts.length ? parts.join('\n\n') : undefined;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'CMC options context fetch failed');
    return undefined;
  }
}
