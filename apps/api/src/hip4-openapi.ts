// Offline contract generation: does not load API env, databases or provider SDKs.
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerHip4ReadRoutes } from "./routes/hip4-read.js";

const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Hunch API", version: "0.1.0" } },
  transform: jsonSchemaTransform,
});
registerHip4ReadRoutes(app, {
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
await app.ready();
console.log(JSON.stringify(app.swagger(), null, 2));
await app.close();
