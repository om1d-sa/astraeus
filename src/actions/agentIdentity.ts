import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { registerIdentity, showIdentity } from "../exec/identity";

/** Pull an explicit agentId (number) from the message, e.g. "show identity 42". */
function parseAgentId(text: string): string | undefined {
  const m =
    text.match(/\b(?:id|identity|agent)\s*#?\s*(\d{1,12})\b/i) ||
    text.match(/\b(\d{1,12})\b/);
  return m?.[1];
}

/** Pull an explicit agent URI if the user supplied one. */
function parseUri(text: string): string | undefined {
  const m = text.match(/\b((?:https?|ipfs|data):\S+)/i);
  return m?.[1];
}

/**
 * AGENT_IDENTITY — mint / read Astraeus's ERC-8004 on-chain agent identity (BSC).
 *
 * The ERC-8004 standard is the BNB AI Agent SDK's flagship capability; here it
 * runs through TWAK so it stays self-custody. "register identity" mints the NFT;
 * "show identity <id>" reads its on-chain state.
 */
export const agentIdentityAction: Action = {
  name: "AGENT_IDENTITY",
  similes: [
    "ERC8004",
    "AGENT_ID",
    "REGISTER_IDENTITY",
    "MINT_IDENTITY",
    "SHOW_IDENTITY",
    "ONCHAIN_IDENTITY",
  ],
  description:
    'Mint or read Astraeus\'s ERC-8004 on-chain agent identity on BNB Smart Chain (via TWAK). Use for "register identity", "mint agent identity", "show identity <id>", "my ERC-8004 identity".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Disable the ERC-8004 identity command when ERC8004_IDENTITY_ENABLED=false.
    if (
      (process.env.ERC8004_IDENTITY_ENABLED ?? "true").toLowerCase() === "false"
    )
      return false;
    const t = (message.content?.text ?? "").toLowerCase();
    if (/\berc[\s-]?8004\b/.test(t)) return true;
    return (
      /\bidentity\b/.test(t) &&
      /\b(register|mint|show|create|agent|on-?chain|nft)\b/.test(t)
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text ?? "";
    const wantsShow = /\b(show|get|read|view|status|lookup|fetch)\b/i.test(
      text,
    );

    try {
      if (wantsShow) {
        const agentId = parseAgentId(text);
        if (!agentId) {
          await callback?.({
            text: 'To read an identity, include its id — e.g. "show identity 42".',
            error: true,
          });
          return { text: "no agentId", success: false };
        }
        const r = await showIdentity(agentId);
        if (!r.ok) {
          await callback?.({
            text: `Could not read identity ${agentId}: ${r.error}`,
            error: true,
          });
          return { text: "show failed", success: false };
        }
        const txt = `🪪 ERC-8004 identity #${agentId}${r.uri ? `\n• URI: ${r.uri}` : ""}`;
        await callback?.({ text: txt, actions: ["AGENT_IDENTITY"] });
        return {
          text: txt,
          success: true,
          values: { agentId },
          data: { actionName: "AGENT_IDENTITY", identity: r },
        };
      }

      // Register (mint) — on-chain tx, needs BNB for gas.
      await callback?.({
        text: "Minting Astraeus's ERC-8004 identity on BSC (on-chain tx — needs a little BNB for gas)…",
      });
      const uri = parseUri(text);
      const r = await registerIdentity({
        uri,
        metadata: {
          name: "Astraeus",
          type: "autonomous-trading-agent",
          venue: "bsc",
        },
      });
      if (!r.ok) {
        await callback?.({
          text: `Identity registration failed: ${r.error}`,
          error: true,
        });
        return {
          text: "register failed",
          success: false,
          values: { error: r.error },
        };
      }
      // A defaulted data: URI is a long inline blob — show it compactly.
      const uriLabel = r.uri
        ? r.uri.startsWith("data:")
          ? "inline data: registration doc"
          : r.uri
        : "";
      const txt =
        `🪪 ERC-8004 identity minted on BSC` +
        (r.agentId ? `\n• Agent ID: ${r.agentId}` : "") +
        (r.txHash ? `\n• Tx: ${r.txHash}` : "") +
        (uriLabel ? `\n• URI: ${uriLabel}` : "");
      await callback?.({ text: txt, actions: ["AGENT_IDENTITY"] });
      logger.info(
        { agentId: r.agentId, txHash: r.txHash },
        "ERC-8004 identity minted",
      );
      return {
        text: txt,
        success: true,
        values: { agentId: r.agentId, txHash: r.txHash },
        data: { actionName: "AGENT_IDENTITY", identity: r },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "AGENT_IDENTITY failed");
      await callback?.({ text: `Agent identity error: ${msg}`, error: true });
      return {
        text: "error",
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "register my agent identity" } },
      {
        name: "Astraeus",
        content: {
          text: "🪪 ERC-8004 identity minted on BSC\n• Agent ID: 12\n• Tx: 0x…",
          actions: ["AGENT_IDENTITY"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "show identity 12" } },
      {
        name: "Astraeus",
        content: {
          text: "🪪 ERC-8004 identity #12\n• URI: …",
          actions: ["AGENT_IDENTITY"],
        },
      },
    ],
  ],
};

export default agentIdentityAction;
