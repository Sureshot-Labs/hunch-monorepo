# October 2026 security update

The initial release on 2026-10-22 updated Node, nginx and frontend dependencies
while deferring Bun until a patched stable release existed. The follow-up pins
Bun `1.4.4`, released later that day, in both backend and frontend Dockerfiles
and in the frontend package-manager declaration. Runtime selection is unchanged.

- Node builder and runtime base: `24.22.1-bookworm-slim`.
- nginx: `1.30.6-alpine`.
- Bun: `1.4.4`, including Brotli `1.2.1`.
- No production configuration, schedules, data or host Docker packages change.

At the initial release, stable Bun `1.4.3` still predated the Brotli
CVE-2026-111497 fix. The subsequent
[Bun 1.4.4 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4)
includes [PR 46392](https://github.com/oven-sh/bun/pull/46392) and pins Brotli
`1.2.1`. Updating the bundled Node alone does not protect Bun services.

Verify both actual binaries and application compatibility before deployment.
This addresses the identified Brotli issue, not a claim that every dependency
is free of vulnerabilities. No lockfile dependency resolution changes are needed.

Residual upstream risk: Bun `1.4.4` still pins c-ares `1.34.8` (commit
`c7a3138dcfe3bb0eaaf10c0c24c36dc66dc790ab`). The separate
[c-ares 1.34.9 security release](https://github.com/c-ares/c-ares/releases/tag/v1.34.9)
fixes DNS reply validation and memory-safety issues. This Bun update must not be
reported as remediating those advisories; Hunch-specific exploitability has not
been established. Replacing a system package does not update Bun's bundled copy.
The user explicitly approved releasing `1.4.4` with this DNS issue left open.

Run the regression probe against a locally built image using **each** binary by
feeding the source on stdin (the probe is not copied into the runtime image):

```sh
docker run --rm --network none -i --entrypoint node <built-image> \
  --input-type=module < ops/runtime-security-smoke.mjs
docker run --rm --network none -i --entrypoint bun <built-image> \
  run - < ops/runtime-security-smoke.mjs
```

It verifies both synchronous and byte-at-a-time streaming CVE regression
behavior rather than relying on `process.versions.brotli`, which does not
reflect backports. A pass under one binary does not certify the other.

Companion frontend changes pin Node `24.22.1`, Next.js `16.4.1`, and sharp
`0.35.5`. The dev-only `eslint-config-next` remains `16.3.4`: upgrading its
React Hooks compiler rules introduces unrelated UI lint work and is not required
for runtime remediation. No lint rules are disabled by this patch.
Existing frontend production-only native-wallet
commits are not merged into develop by this patch and must be preserved during
the authorized release merge.

## Bun 1.4.4 follow-up verification

- Full backend workspace build/typecheck/lint: 47/47 tasks. Fresh Linux ARM64
  image build: frozen dependency installation and 16/16 workspace builds passed.
- The final backend image passed 65/65 fast-suite files under Node `24.22.1`
  and all 62 Bun-compatible files under Bun `1.4.4`; three Node-only mocking
  wrappers remain tested under Node. Both binaries passed synchronous and
  streaming Brotli regression checks. Tests were offline with dummy settings.
- Bun `1.4.4` can report a killed child as exit code `0` / signal `null`.
  The FFmpeg wrapper now also checks explicit termination and abort state before
  reporting success. Abort and direct-kill tests cover this compatibility fix.
- Frontend frozen installation requires native compiler prerequisites for
  ARM64 `bufferutil`. Its dependency stage now uses the same Node/bookworm base
  as the build and runtime, with Python/make/g++ confined to that build stage.
  Runtime remains non-root and does not contain the compiler toolchain.
- Frontend develop tests: 1,663 passed; merged production-tree tests: 1,677
  passed. Full frontend typecheck and lint passed. The existing unrelated
  `AGENTS.md` second-heading markdownlint warning remains unchanged.
- The merged frontend ARM64 image passed Node/Turbopack build, both runtime
  Brotli probes, and offline HTTP 200 smoke checks for SSR, static PNG, Next
  image optimization, and native-wallet HTML/JS under both Node and Bun.
  No restarts or OOM occurred. Public app IDs were synthetic, not production
  credentials; authenticated flows were not exercised.
- Independent review covered runtime pins, Docker stages, regression probes
  and the FFmpeg fix; no blocking findings remain in the code review.

Local build/compatibility checks do not replace post-deployment image, health
and natural worker-cycle verification, or authenticated production smoke tests.

## Initial release verification (2026-10-22, before Bun 1.4.4)

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

Those initial compatibility checks did not remediate the Bun vulnerability. The initial
patch verification made no production changes or live transactions. The user
subsequently authorized commit, merge, push and deployment monitoring, with Bun
remediation explicitly deferred; production configuration and schedules remain
outside this patch.

References:

- [Node October 21 advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [nginx advisories](https://nginx.org/en/security_advisories.html)
- [Next October 14 advisory](https://nextjs.org/blog/nextjs-security-update-october-14-2026)
