import { tx } from "@hunch/infra";
import { pool } from "./db.js";
import { provisionAgentProfiles } from "./services/agent-theses-provision.js";
import { AGENT_TEMPLATES } from "./services/agent-theses-policy.js";
import {
  agentAdminCreate,
  createAgentAdminProfile,
  readAgentAdminState,
  lockAgentConfiguration,
} from "./services/agent-theses-admin.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
try {
  const flags = new Map<string, string>();
  let execute = false,
    dryRun = false;
  for (const arg of args) {
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const match =
      /^--(handle|name|bio|template|interests|approach|style)=(.+)$/s.exec(arg);
    if (!match || flags.has(match[1]))
      throw new Error("Invalid or duplicate argument");
    flags.set(match[1], match[2]);
  }
  if (execute && dryRun) throw new Error("Choose execute or dry-run");
  const template = AGENT_TEMPLATES.find((t) => t.id === flags.get("template"));
  if (flags.has("template") && !template) throw new Error("Unknown template");
  if (!flags.get("handle") || !flags.get("name"))
    throw new Error(
      "Explicit --handle and --name are required; no agents are created by default",
    );
  const result = await tx(pool, async (db) => {
    await lockAgentConfiguration(db);
    const current = await readAgentAdminState(db);
    const input = agentAdminCreate.parse({
      revision: current.revision,
      handle: flags.get("handle"),
      displayName: flags.get("name"),
      bio: flags.get("bio") ?? template?.bio ?? "",
      settings: {
        interests: flags.get("interests") ?? template?.interests,
        approach: flags.get("approach") ?? template?.approach,
        style: flags.get("style") ?? template?.style,
        paperAmountUsd: "100",
      },
    });
    const preview = await provisionAgentProfiles(
      db,
      [
        {
          handle: input.handle,
          name: input.displayName,
          bio: input.bio,
        },
      ],
      false,
    );
    if (!execute) return preview;
    // Retrying the same configured handle is idempotent; never reconfigure it.
    const existing = preview.authors[0];
    if (
      existing.userId &&
      current.policy.authors.some((a) => a.userId === existing.userId)
    )
      return { execute: true, authors: preview.authors };
    const created = await createAgentAdminProfile(db, input, null);
    const profile = created.profiles.find(
      (p) => p.handle === input.handle.trim().toLowerCase(),
    );
    if (!profile) throw new Error("agent_profile_unavailable");
    return {
      execute: true,
      authors: [
        { handle: profile.handle, userId: profile.id, action: "created" },
      ],
    };
  });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
