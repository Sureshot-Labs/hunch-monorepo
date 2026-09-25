import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../mini-app/index.html", import.meta.url));
const port = Number(process.env.TELEGRAM_PREVIEW_PORT ?? 8787);
const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : page);
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Static Mini App: http://127.0.0.1:${port}. Use an HTTPS tunnel URL in TELEGRAM_PREVIEW_WEB_APP_URL.`,
  ),
);
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
