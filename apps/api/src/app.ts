import Fastify from "fastify";
import { onReqEnd, onReqStart } from "./metrics.js";
import { registerRoutes } from "./routes/index.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  app.addHook("onRequest", async (req, _reply) => {
    req._t0 = onReqStart();
  });
  app.addHook("onResponse", async (req, _reply) => {
    if (req._t0 != null) onReqEnd(req._t0);
  });

  await registerRoutes(app);

  return app;
}
