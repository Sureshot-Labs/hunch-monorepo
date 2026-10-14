// Offline contract generation: does not load API env, databases or provider SDKs.
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerHip4ReadRoutes } from "./routes/hip4-read.js";
import { registerHip4AccountRoutes } from "./routes/hip4-account.js";
import { positionReadRouteSchemas } from "./schemas/position-read.js";
import { venueMetadataRouteSchema } from "./schemas/venue-metadata.js";
import { accountValueReadRouteSchemas } from "./schemas/account-value.js";
import { orderReadRouteSchemas } from "./schemas/orders.js";
import {
  fundingActionSigningRouteSchemas,
  fundingOperationReadRouteSchemas,
  fundingOperationWriteRouteSchemas,
} from "./schemas/funding.js";

const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Hunch API", version: "0.1.0" } },
  transform: jsonSchemaTransform,
});
app.get("/meta/venues", { schema: venueMetadataRouteSchema }, async () => {
  throw new Error("schema_only");
});
for (const surface of ["public", "canary"] as const)
  registerHip4ReadRoutes(app, {
    surface,
    authorize: async () => {
      throw new Error("schema_only");
    },
    policy: async () => {
      throw new Error("schema_only");
    },
    markets: async () => {
      throw new Error("schema_only");
    },
  });
for (const surface of ["owned", "canary"] as const)
  registerHip4AccountRoutes(app, {
    surface,
    authorize: async () => {
      throw new Error("schema_only");
    },
    owns: async () => {
      throw new Error("schema_only");
    },
    service: {
      policy: async () => {
        throw new Error("schema_only");
      },
      load: async () => {
        throw new Error("schema_only");
      },
    },
    executions: async () => {
      throw new Error("schema_only");
    },
  });
for (const [path, schema] of Object.entries({
  ...positionReadRouteSchemas,
  ...accountValueReadRouteSchemas,
  // Runtime bounds come from existing API env. Catch/transform values are not
  // serialized by OpenAPI; these placeholders are never used by a handler.
  ...orderReadRouteSchemas({
    defaultLimit: 1,
    maxLimit: Number.MAX_SAFE_INTEGER,
  }),
})) {
  app.get(path, { schema }, async () => {
    throw new Error("schema_only");
  });
}
for (const [path, schema] of Object.entries({
  ...fundingActionSigningRouteSchemas,
  ...fundingOperationWriteRouteSchemas,
})) {
  app.post(path, { schema }, async () => {
    throw new Error("schema_only");
  });
}
for (const [path, schema] of Object.entries(fundingOperationReadRouteSchemas)) {
  app.get(path, { schema }, async () => {
    throw new Error("schema_only");
  });
}
await app.ready();
console.log(JSON.stringify(app.swagger(), null, 2));
await app.close();
