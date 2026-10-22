# October 2026 security update (pending Bun)

Release status: **partial remediation authorized on 2026-10-22**. The user
explicitly authorized releasing the Node, nginx and frontend dependency fixes
while retaining Bun and deferring its fix. This is not full security clearance.

- Node builder and runtime base: `24.22.1-bookworm-slim`.
- nginx: `1.30.6-alpine`.
- Bun remains `1.4.0`; the existing runtime selection is unchanged.
- No production configuration, schedules, data or host Docker packages change.

On 2026-10-22 the latest stable Bun release was still `1.4.3`, which predates
the Brotli CVE-2026-111497 fix. The fix was merged in
[Bun PR 46392](https://github.com/oven-sh/bun/pull/46392), but a merge is not a
patched release. Updating the bundled Node alone does not protect Bun services.

For the follow-up Bun remediation, confirm the stable release includes that fix, update the
Bun image/version assertions in both repositories and frontend package-manager
pin, rerun the builds and runtime/application smoke tests under that exact Bun
version, and review the final diff. Until then, the Bun vulnerability remains open.

Run the Node-only regression probe against a locally built backend image by
feeding the source on stdin (the probe is not copied into the runtime image):

```sh
docker run --rm --network none -i --entrypoint node <built-image> \
  --input-type=module < ops/runtime-security-smoke.mjs
```

It verifies the CVE regression behavior rather than relying on
`process.versions.brotli`, which does not reflect backports. It must never be
mistaken for a Bun security test.

Companion frontend changes pin Node `24.22.1`, Next.js `16.4.1`, and sharp
`0.35.5`. The dev-only `eslint-config-next` remains `16.3.4`: upgrading its
React Hooks compiler rules introduces unrelated UI lint work and is not required
for runtime remediation. No lint rules are disabled by this patch.
Existing frontend production-only native-wallet
commits are not merged into develop by this patch and must be preserved during
the authorized release merge.

## Local verification (2026-10-22)

- Backend workspace build/typecheck/lint: 47/47 tasks; local fast suite passed.
  A fresh Linux ARM64 Docker build also completed its frozen install and full
  workspace build under Node `24.22.1` (not just cached host tasks).
- Built backend image: Node Brotli regression passed; 65/65 API fast-suite files
  passed under Node. The 62 Bun-compatible files passed using Bun `1.4.0`'s test
  runner; three Node-only module-mocking wrappers were verified under Node.
  Image tests used dummy configuration, no networking, and read-only source
  documentation fixtures that are intentionally absent from the shipped image.
- Frontend: typecheck, full lint and 1,662 tests passed. The final Linux ARM64
  deploy-equivalent Node/Turbopack Docker build passed. Offline startup, homepage
  SSR, static PNG and Next image optimization returned HTTP 200 under both Node
  `24.22.1` and Bun `1.4.0`, with no restarts or OOM. No real API/auth credentials
  were used; this does not certify authenticated flows against production.
- nginx `1.30.6`: existing configuration passed `nginx -t`; HTTP redirect, TLS
  and API/frontend/category/RPC proxy routing passed on an isolated internal
  network with mock upstreams and a temporary test certificate.
- Independent diff review completed; reported test/documentation issues fixed.

These compatibility checks do not remediate the Bun vulnerability. The initial
patch verification made no production changes or live transactions. The user
subsequently authorized commit, merge, push and deployment monitoring, with Bun
remediation explicitly deferred; production configuration and schedules remain
outside this patch.

References:

- [Node October 21 advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [nginx advisories](https://nginx.org/en/security_advisories.html)
- [Next October 14 advisory](https://nextjs.org/blog/nextjs-security-update-october-14-2026)
