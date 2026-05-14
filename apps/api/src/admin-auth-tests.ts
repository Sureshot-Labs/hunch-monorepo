import assert from "node:assert/strict";
import {
  adminHasPermission,
  adminRoleAllowed,
  buildTotpUri,
  hashAdminPassword,
  resolveAdminManagementLockout,
  verifyAdminPassword,
  verifyTotpCode,
} from "./services/admin-auth.js";

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[admin-auth-tests] ok ${name}`);
}

await test("hashes and verifies admin passwords with scrypt", async () => {
  const hash = await hashAdminPassword("correct-password-123");
  assert.equal(await verifyAdminPassword("correct-password-123", hash), true);
  assert.equal(await verifyAdminPassword("wrong-password-123", hash), false);
  assert.equal(await verifyAdminPassword("correct-password-123", "bad"), false);
});

await test("rejects weak admin passwords", async () => {
  await assert.rejects(() => hashAdminPassword("short1"), /Password must/);
  await assert.rejects(
    () => hashAdminPassword("longpasswordonly"),
    /Password must/,
  );
});

await test("verifies 6-digit TOTP and rejects replay counters", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const accepted = verifyTotpCode({
    secret,
    code: "287082",
    nowMs: 30_000,
  });
  assert.deepEqual(accepted, { ok: true, counter: 1 });

  const replay = verifyTotpCode({
    secret,
    code: "287082",
    nowMs: 30_000,
    minCounterExclusive: 1,
  });
  assert.deepEqual(replay, { ok: false, replay: true });
});

await test("builds authenticator-compatible TOTP URIs", () => {
  const uri = buildTotpUri({
    email: "admin@example.com",
    secret: "ABCDEF234567",
    issuer: "Hunch Admin",
  });
  assert.equal(
    uri,
    "otpauth://totp/Hunch%20Admin%3Aadmin%40example.com?secret=ABCDEF234567&issuer=Hunch+Admin&algorithm=SHA1&digits=6&period=30",
  );
});

await test("enforces sadmin-only role gates", () => {
  assert.equal(adminRoleAllowed("analyst", "analyst"), true);
  assert.equal(adminRoleAllowed("viewer", "analyst"), true);
  assert.equal(adminRoleAllowed("admin", "viewer"), true);
  assert.equal(adminRoleAllowed("admin", "admin"), true);
  assert.equal(adminRoleAllowed("sadmin", "admin"), true);
  assert.equal(adminRoleAllowed("analyst", "viewer"), false);
  assert.equal(adminRoleAllowed("viewer", "admin"), false);
  assert.equal(adminRoleAllowed("admin", "sadmin"), false);
  assert.equal(adminRoleAllowed("sadmin", "sadmin"), true);
});

await test("maps admin role permissions conservatively", () => {
  assert.equal(adminHasPermission("sadmin", "admin:manage"), true);
  assert.equal(adminHasPermission("admin", "users:write"), true);
  assert.equal(adminHasPermission("admin", "admin:manage"), false);
  assert.equal(adminHasPermission("viewer", "users:read"), true);
  assert.equal(adminHasPermission("viewer", "users:write"), false);
  assert.equal(adminHasPermission("viewer", "finance:read"), true);
  assert.equal(adminHasPermission("viewer", "finance:write"), false);
  assert.equal(adminHasPermission("analyst", "analytics:read"), false);
  assert.equal(adminHasPermission("analyst", "intel:read"), false);
  assert.equal(adminHasPermission("analyst", "users:read"), false);
  assert.equal(adminHasPermission("analyst", "rewards:read"), false);
});

await test("prevents admin-management lockouts", () => {
  assert.equal(
    resolveAdminManagementLockout({
      actorAdminId: "admin-a",
      targetAdminId: "admin-a",
      targetStatus: "active",
      targetRole: "sadmin",
      action: "disable",
      otherActiveSadminCount: 1,
    }),
    "admin_self_action_forbidden",
  );
  assert.equal(
    resolveAdminManagementLockout({
      actorAdminId: "admin-a",
      targetAdminId: "admin-a",
      targetStatus: "active",
      targetRole: "sadmin",
      action: "set_role",
      nextRole: "admin",
      otherActiveSadminCount: 1,
    }),
    "admin_self_action_forbidden",
  );
  assert.equal(
    resolveAdminManagementLockout({
      actorAdminId: "admin-a",
      targetAdminId: "admin-b",
      targetStatus: "active",
      targetRole: "sadmin",
      action: "disable",
      otherActiveSadminCount: 0,
    }),
    "admin_last_sadmin_forbidden",
  );
  assert.equal(
    resolveAdminManagementLockout({
      actorAdminId: "admin-a",
      targetAdminId: "admin-a",
      targetStatus: "active",
      targetRole: "sadmin",
      action: "rotate_link",
      otherActiveSadminCount: 1,
    }),
    "admin_self_action_forbidden",
  );
  assert.equal(
    resolveAdminManagementLockout({
      actorAdminId: "admin-a",
      targetAdminId: "admin-b",
      targetStatus: "active",
      targetRole: "sadmin",
      action: "rotate_link",
      otherActiveSadminCount: 0,
    }),
    "admin_last_sadmin_forbidden",
  );
  assert.equal(
    resolveAdminManagementLockout({
      actorAdminId: "admin-a",
      targetAdminId: "admin-b",
      targetStatus: "active",
      targetRole: "sadmin",
      action: "set_role",
      nextRole: "admin",
      otherActiveSadminCount: 0,
    }),
    "admin_last_sadmin_forbidden",
  );
  assert.equal(
    resolveAdminManagementLockout({
      actorAdminId: "admin-a",
      targetAdminId: "admin-b",
      targetStatus: "active",
      targetRole: "sadmin",
      action: "set_role",
      nextRole: "admin",
      otherActiveSadminCount: 1,
    }),
    null,
  );
  assert.equal(
    resolveAdminManagementLockout({
      actorAdminId: "admin-a",
      targetAdminId: "admin-b",
      targetStatus: "active",
      targetRole: "admin",
      action: "set_role",
      nextRole: "sadmin",
      otherActiveSadminCount: 0,
    }),
    null,
  );
});
