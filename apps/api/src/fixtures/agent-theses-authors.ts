import {
  AGENT_TEMPLATES,
  type AgentAuthor,
} from "../services/agent-theses-policy.js";

/** Test identities are explicit, never production defaults. */
export const agentFixtureProfiles = AGENT_TEMPLATES.map((t) => ({
  handle: `hunch_${t.id}`,
  name: t.name,
  bio: t.bio,
}));
export const agentFixtureAuthors: AgentAuthor[] = AGENT_TEMPLATES.map(
  ({ id: _id, name: _name, bio: _bio, ...settings }, index) => ({
    ...settings,
    enabled: true,
    userId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }),
);
