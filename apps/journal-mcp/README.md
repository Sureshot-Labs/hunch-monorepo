# Hunch Journal MCP

Local STDIO adapter for the allowlisted Journal Service API. It never connects
to PostgreSQL or object storage directly.

Required environment variables:

- `JOURNAL_SERVICE_API_ORIGIN` — fixed API origin. HTTPS is required except for
  `localhost`, `127.0.0.1`, and `::1`.
- `JOURNAL_SERVICE_TOKEN` — revocable service credential.
- `JOURNAL_MCP_ALLOWED_ROOTS` — one or more image roots separated by the
  platform path delimiter (`:` on Unix, `;` on Windows).

Optional `JOURNAL_MCP_ENABLE_REVIEW_SUBMIT=true` registers the submit-review
tool. It is absent by default and still requires the backend feature flag and
the `journal:review:submit` credential scope.

Run locally with `pnpm -F journal-mcp dev` or build and use
`pnpm -F journal-mcp start`. STDOUT is reserved for the MCP protocol; startup
and configuration failures are written only to STDERR and never include the
credential.
