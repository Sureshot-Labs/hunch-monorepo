import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { onReqEnd, onReqStart } from "./metrics.js";
import { registerRoutes } from "./routes/index.js";
import { isRecord } from "./lib/type-guards.js";
import { env } from "./env.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: env.trustProxy,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onRequest", async (req, _reply) => {
    req._t0 = onReqStart();
  });
  app.addHook("onResponse", async (req, _reply) => {
    if (req._t0 != null) onReqEnd(req._t0);
  });

  app.setErrorHandler((error, request, reply) => {
    const zodIssues =
      error instanceof ZodError
        ? error.issues
        : isRecord(error) && Array.isArray(error.issues)
          ? error.issues
          : null;

    if (zodIssues) {
      const message =
        isRecord(zodIssues[0]) && typeof zodIssues[0].message === "string"
          ? zodIssues[0].message
          : "Invalid request";
      reply.code(400).send({ error: message });
      return;
    }

    request.log.error({ error }, "Unhandled error");
    reply.send(error);
  });

  if (env.enableSwagger) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Hunch API",
          version: "0.1.0",
        },
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
      routePrefix: "/docs",
    });

    app.get(
      "/openapi.json",
      {
        schema: {
          hide: true,
        },
      },
      async (_request, reply) => {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(app.swagger());
      },
    );
  }

  await registerRoutes(app);

  return app;
}
