// Make the central_messages insert an UPSERT, so a re-used message id can never
// silently drop an agent reply.
//
// The bug: an action that calls callback() more than once — a progress note then the
// final result, which every slow CMC feature does (PORTFOLIO/LIQUIDATION/AGENT_DEBUG:
// "📊 Analyzing…" then "📊 …risk analysis — <result>") — reuses ONE response id
// (sendAgentResponseToBus sends messageId: content.responseId for each callback). The
// first callback INSERTs that id fine; the final callback INSERTs the SAME id again →
// `duplicate key value violates unique constraint "central_messages_pkey"`. ElizaOS's
// MessagingStore.createMessage does a plain INSERT (never an upsert), so the SQL plugin
// retries 3× and the server returns 500 — the final result is dropped while the
// progress note remains. That's the "Completed but no result" symptom.
//
// The fix: ON CONFLICT (id) DO UPDATE — a re-submitted id updates the row in place
// (the "Analyzing…" placeholder becomes the finished result) instead of failing. This
// is the correct, idempotent behavior for a message store and covers every route that
// persists a message (/submit, /action, …). createdAt/channelId/authorId are left
// untouched; only the mutable fields are updated.
//
// Runs on postinstall so it survives `bun install`. Idempotent (marker-guarded) and
// best-effort: never fails the install if the plugin bundle changed shape.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "node_modules/@elizaos/plugin-sql/dist/node/index.node.js",
  "node_modules/@elizaos/plugin-sql/dist/browser/index.browser.js",
];

const MARKER = "astraeus-upsert-message";
const NEEDLE = "await this.db.insert(messageTable).values(messageToInsert);";
const PATCHED =
  "await this.db.insert(messageTable).values(messageToInsert).onConflictDoUpdate({ target: messageTable.id, set: { content: messageToInsert.content, rawMessage: messageToInsert.rawMessage, metadata: messageToInsert.metadata, inReplyToRootMessageId: messageToInsert.inReplyToRootMessageId, sourceType: messageToInsert.sourceType, updatedAt: messageToInsert.updatedAt } }); /* " +
  MARKER +
  " */";

for (const rel of targets) {
  const file = join(root, rel);
  try {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    if (src.includes(MARKER)) continue; // already patched
    if (!src.includes(NEEDLE)) {
      console.warn(
        `[patch-message-upsert] anchor not found in ${rel} (plugin updated?) — skipping`,
      );
      continue;
    }
    writeFileSync(file, src.replace(NEEDLE, PATCHED));
    console.log(`[patch-message-upsert] central_messages insert is now an upsert in ${rel}`);
  } catch (err) {
    console.warn(`[patch-message-upsert] skipped ${rel}: ${err?.message || err}`);
  }
}
