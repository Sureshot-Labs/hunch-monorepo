import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Preserve local .env startup without importing the API's required secrets.
// Production's existing run-with-secrets wrapper has already populated env.
if (process.env.HUNCH_RUNTIME_SECRETS_LOADED !== "1") {
  config({
    path: fileURLToPath(new URL("../../../.env", import.meta.url)),
    override: true,
  });
}
