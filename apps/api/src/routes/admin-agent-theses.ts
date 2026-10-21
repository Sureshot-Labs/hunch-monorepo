import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DbQuery } from "../db.js";
import {
  agentAdminCreate,
  agentAdminSave,
  agentAdminStateSchema,
  createAgentAdminProfile,
  readAgentAdminState,
  saveAgentAdminConfiguration,
} from "../services/agent-theses-admin.js";
import { SocialError } from "../services/social-primitives.js";
import {
  agentPreviewInputSchema,
  agentPreviewSchema,
} from "../schemas/agent-preview.js";
import type { AgentPreviewService } from "../services/agent-theses-preview.js";

export type AgentAdminDependencies = {
  preview?: Pick<AgentPreviewService, "start" | "read" | "budget">;
  db: DbQuery;
  authorize: (
    permission: "intel:read" | "intel:write" | "users:write",
  ) => preHandlerHookHandler;
  transact: <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;
};
const errorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
const response = {
  200: agentAdminStateSchema,
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  503: errorSchema,
};
function actor(request: FastifyRequest) {
  const id =
    request.adminAccount?.id ??
    (request.adminActor?.kind === "admin_account"
      ? request.adminActor.id
      : null);
  if (!id) throw new SocialError("admin_access_required", 401);
  return id;
}
function failure(reply: FastifyReply, error: unknown) {
  const messages: Record<string, string> = {
    preview_busy:
      "Another paid preview is running. Wait for it to finish, then try again.",
    preview_not_found:
      "Preview expired or was not found. A new paid run requires another click.",
    preview_request_conflict:
      "This request ID was already used for different settings. Start a new test explicitly.",
    agent_budget_exhausted:
      "The separate preview budget is exhausted or cannot cover the next call reservation.",
    preview_unavailable: "Paid previews are temporarily unavailable.",
    agent_unavailable: "This agent is unavailable or suspended.",
    model_key_unavailable: "The model provider is not configured.",
    agent_configuration_changed:
      "Settings changed since you opened this page. Reload and review before saving.",
    agent_profile_binding_changed:
      "Agent profile assignments cannot be changed through this form.",
    agent_handle_conflict:
      "That handle is already in use. Choose a different handle.",
    invalid_handle:
      "Use a handle within the allowed length, with letters, numbers and underscores only.",
    agent_no_enabled_author:
      "Create and enable at least one available author before starting publication.",
    invalid_text_length: "Name or bio exceeds the allowed length.",
    agent_avatar_unavailable:
      "Choose a verified image within the avatar size limit. The selected image is unavailable or too large.",
  };
  if (error instanceof SocialError)
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.code.startsWith("agent_handle_owned_by_user:")
        ? "That handle belongs to a regular user. No account was changed."
        : (messages[error.code] ?? error.code),
    });
  const code = (error as { code?: string })?.code;
  if (code === "23505")
    return reply.code(409).send({
      error: "agent_handle_conflict",
      message: "That handle is already in use. Reload before trying again.",
    });
  requestError(reply, code);
  return reply.code(503).send({
    error: "agent_admin_unavailable",
    message:
      "Agent settings are temporarily unavailable. Retry or check that the backend migration is deployed.",
  });
}
function requestError(reply: FastifyReply, code: string | undefined) {
  reply.log.error(
    { errorCode: code ?? "unknown" },
    "Agent administration failed",
  );
}
export function registerAdminAgentThesesRoutes(
  app: FastifyInstance,
  deps: AgentAdminDependencies,
) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    "/admin/agent-theses",
    {
      preHandler: deps.authorize("intel:read"),
      schema: { response },
    },
    async (_request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const state = await readAgentAdminState(deps.db);
        const previewBudget =
          (await deps.preview?.budget().catch(() => null)) ?? null;
        return { ...state, previewBudget };
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  const writers = [
    deps.authorize("intel:write"),
    deps.authorize("users:write"),
  ];
  api.post(
    "/admin/agent-theses/authors/:userId/preview",
    {
      bodyLimit: 256 * 1024,
      preHandler: writers,
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        body: agentPreviewInputSchema,
        response: {
          202: agentPreviewSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        if (!deps.preview) throw new SocialError("preview_unavailable", 503);
        return reply
          .code(202)
          .send(
            await deps.preview.start(
              actor(request),
              request.params.userId,
              request.body,
            ),
          );
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  api.get(
    "/admin/agent-theses/previews/:runId",
    {
      preHandler: deps.authorize("intel:read"),
      schema: {
        params: z.object({ runId: z.string().regex(/^[a-f0-9]{64}$/) }),
        response: {
          200: agentPreviewSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        if (!deps.preview) throw new SocialError("preview_unavailable", 503);
        return await deps.preview.read(request.params.runId);
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  api.put(
    "/admin/agent-theses",
    {
      preHandler: writers,
      schema: { body: agentAdminSave, response },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const id = actor(request);
        return await deps.transact((db) =>
          saveAgentAdminConfiguration(db, request.body, id),
        );
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  api.post(
    "/admin/agent-theses/authors",
    {
      preHandler: writers,
      schema: { body: agentAdminCreate, response },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const id = actor(request);
        return await deps.transact((db) =>
          createAgentAdminProfile(db, request.body, id),
        );
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
}
