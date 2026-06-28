// Make agent replies survive a deleted channel, so a SLOW reply (e.g. a CMC
// liquidation/portfolio analysis that takes up to CMC_SKILLS_TIMEOUT_MS) always
// persists no matter how late it lands.
//
// The bug: central_messages.channel_id has a FK -> channels(id) with ON DELETE
// CASCADE. While a slow analysis is running, the ElizaOS GUI can delete the DM
// channel (new chat / clear / auto-title rotation). When the reply finally posts to
// /api/messaging/{submit,action}, the channel row is gone, so the INSERT violates
// the FK; the SQL plugin retries 3x and the server returns 500, silently dropping
// the reply. (The real Postgres reason is hidden on error.cause, which ElizaOS's
// withRetry never logs, so the log only shows "Failed query: ... params: ...".)
//
// The fix: right before persisting the message, re-create the channel row if it's
// missing. createChannel uses onConflictDoNothing(), so this is a cheap no-op when
// the channel still exists and a re-materialization when it was deleted — the late
// reply then has a channel to attach to and is never lost. message_server_id is
// available in the request body (and already validated), giving us everything the
// channels table requires (id, message_server_id, name, type).
//
// Runs on postinstall so it survives `bun install`. Idempotent (marker-guarded) and
// best-effort: never fails the install if the server bundle changed shape.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "node_modules/@elizaos/server/dist/index.js");

const MARKER = "astraeus-ensure-channel";

// Idempotent channel re-materialization. Uses vars already in scope at both the
// /submit and /action handlers: serverInstance, channel_id, message_server_id,
// metadata, raw_message, validateUuid10, logger11.
const ENSURE = `try { /* ${MARKER} */ await serverInstance.createChannel({ id: validateUuid10(channel_id), messageServerId: validateUuid10(message_server_id), name: (metadata && metadata.channelName) || "Chat", type: (metadata && (metadata.channelType || metadata.type)) || (raw_message && raw_message.channelType) || "DM" }); } catch (e) { logger11.warn({ src: "http", channelId: channel_id, error: e instanceof Error ? e.message : String(e) }, "[${MARKER}] re-create channel before message insert failed (continuing)"); }`;

// Both message-persisting routes; they differ only in the result variable name.
const ANCHORS = [
  "const createdMessage = await serverInstance.createMessage(newRootMessageData);",
  "const createdRootMessage = await serverInstance.createMessage(newRootMessageData);",
];

try {
  if (!existsSync(file)) {
    console.warn("[patch-survive-channel-deletion] @elizaos/server not found — skipping");
    process.exit(0);
  }
  let src = readFileSync(file, "utf8");
  if (src.includes(MARKER)) process.exit(0); // already patched

  let patched = 0;
  for (const anchor of ANCHORS) {
    if (!src.includes(anchor)) continue;
    src = src.replace(anchor, `${ENSURE}\n      ${anchor}`);
    patched++;
  }

  if (patched === 0) {
    console.warn(
      "[patch-survive-channel-deletion] no anchors found in @elizaos/server (updated?) — skipping",
    );
    process.exit(0);
  }
  writeFileSync(file, src);
  console.log(
    `[patch-survive-channel-deletion] patched ${patched} message route(s) to re-create a deleted channel before insert`,
  );
} catch (err) {
  console.warn(`[patch-survive-channel-deletion] skipped: ${err?.message || err}`);
}
