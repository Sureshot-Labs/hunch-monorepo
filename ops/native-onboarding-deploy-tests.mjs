import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "hunch-native-deploy-test-"));
const app = join(root, "hunch-monorepo"),
  bin = join(root, "bin"),
  settings = join(root, "native.env"),
  stateFile = join(root, "state.json"),
  logFile = join(root, "calls.jsonl");
mkdirSync(join(app, "ops"), { recursive: true });
mkdirSync(bin);
copyFileSync(
  join(repo, "ops/native-onboarding-deploy.sh"),
  join(app, "ops/native-onboarding-deploy.sh"),
);
writeFileSync(join(app, "ops/docker-compose.prod.yml"), "services: {}\n");
writeFileSync(join(app, "ops/market-matcher-deploy.sh"), "#!/bin/sh\nexit 0\n");
const mock = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const name=path.basename(process.argv[1]),args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(process.env.NATIVE_TEST_STATE,'utf8'));
fs.appendFileSync(process.env.NATIVE_TEST_LOG,JSON.stringify({name,args})+'\n');
const save=()=>fs.writeFileSync(process.env.NATIVE_TEST_STATE,JSON.stringify(state));
if(name==='ssh'){const r=spawnSync('bash',['-c',args.at(-1)],{input:fs.readFileSync(0),stdio:['pipe','inherit','inherit'],env:process.env});process.exit(r.status??1);}
if(name==='sleep'||name==='curl')process.exit(0);
if(name==='docker-compose'){
 const command=args.find(a=>['up','stop','rm','build','run','ps','logs','down'].includes(a));
 if(command==='run'&&state.migrationFails&&args.some(a=>a.endsWith('/migrate.js')))process.exit(1);
 if(command==='ps'){console.log(args.includes('redis')?'redis-id':'social-id');process.exit(0);}
 if(command==='up'&&(args.includes('native-onboarding-worker')||(args.includes('--profile')&&args.at(-1)==='-d'))){state.existing=true;state.stopped=false;save();}
 process.exit(0);
}
if(name==='docker'){
 if(args[0]==='ps'&&args.some(a=>a.includes('hunch-nginx')))console.log('nginx-id');
 if(args[0]==='inspect'){
  const native=args.at(-1)==='hunch-native-onboarding-worker';
  if(native&&!state.existing)process.exit(1);
  const format=args[2]??'';
  if(format.includes('com.docker.compose.service'))console.log(state.foreign?'other other':'native-onboarding-worker hunch-monorepo');
  else if(format.includes('.State.Status'))console.log(state.coreNotReady?'running unhealthy 0':'running healthy 0');
  else if(format.includes('.State.Running'))console.log('true');
  else if(format.includes('.RestartCount'))console.log('0');
  else if(format.includes('.Config.Image'))console.log('hunch-backend:test');
  else if(format.includes('.Image'))console.log(native&&state.wrongImage?'sha256:other':'sha256:expected');
  else console.log('{}');
  process.exit(0);
 }
 if(args[0]==='image'&&args[1]==='inspect'){console.log('sha256:expected');process.exit(0);}
 if(args[0]==='run'&&args.some(a=>a.includes('native-push-worker.js'))&&state.incompatible)process.exit(1);
 if(args[0]==='exec'){
  if(args.some(a=>a.includes('native-onboarding-health.js'))){if(state.deliveryNotReady&&args.includes('--require-delivery'))process.exit(1);console.log('{"event":"native_worker_ready"}');}
  else if(args.some(a=>a.toLowerCase()==='ping'))console.log('PONG');else if(args.includes('config'))console.log('OK');
 }
 if(args[0]==='stop'&&args.includes('hunch-native-onboarding-worker')){state.stopped=true;save();}
 process.exit(0);
}
process.exit(99);
`;
for (const name of ["docker", "docker-compose", "ssh", "sleep", "curl"])
  writeFileSync(join(bin, name), mock, { mode: 0o755 });
const env = {
  ...process.env,
  PATH: bin + ":" + process.env.PATH,
  APP_DIR: app,
  ENV_FILE: settings,
  COMPOSE_PROJECT_NAME: "hunch-monorepo",
  PROJECT_NAME: "hunch-monorepo",
  NATIVE_TEST_STATE: stateFile,
  NATIVE_TEST_LOG: logFile,
  DOCKER_PRUNE: "0",
  ARCHIVE: "",
  IMAGE_ARCHIVE: "",
  HUNCH_BACKEND_IMAGE: "hunch-backend:test",
  HUNCH_SOCIAL_MEDIA_WORKER_IMAGE: "hunch-social-media-worker:test",
  BACKEND_IMAGE: "hunch-backend:test",
  RESTART_NGINX: "0",
  VERIFY: "0",
};
delete env.SERVICES;
delete env.HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED;
delete env.HUNCH_APNS_DELIVERY_ENABLED;
let checks = 0;
function reset(value = "", state = {}) {
  writeFileSync(settings, value);
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(logFile, "");
}
function run(script, extra = {}) {
  return spawnSync("bash", [join(repo, "ops", script)], {
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 20000,
  });
}
const calls = () =>
  readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((v) => JSON.parse(v));
const mutatesApplications = (call) =>
  (call.name === "docker-compose" &&
    ["stop", "rm"].some((v) => call.args.includes(v))) ||
  (call.name === "docker" && ["stop", "rm"].includes(call.args[0]));
try {
  for (const value of [
    "",
    "HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=false\n",
    'export HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED="true" # enable\n',
    "HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED='false'\n",
  ]) {
    reset(value);
    const r = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; native_onboarding_flag HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED',
        "test",
        join(repo, "ops/native-onboarding-deploy.sh"),
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), value.includes("true") ? "true" : "false");
    checks++;
  }
  for (const script of [
    "deploy-ec2-prebuilt.sh",
    "deploy-ec2.sh",
    "recreate-services-no-build.sh",
    "restart-all.sh",
  ]) {
    for (const enabled of [false, true]) {
      reset("HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=" + enabled + "\n");
      const r = run(script);
      assert.equal(r.status, 0, script + ": " + r.stderr + "\n" + r.stdout);
      const started = calls().filter(
        (c) =>
          c.name === "docker-compose" &&
          c.args.includes("up") &&
          c.args.includes("api"),
      );
      assert.ok(started.length);
      assert.equal(
        started.some(
          (c) =>
            c.args.includes("native-onboarding-worker") ||
            c.args.includes("native-onboarding"),
        ),
        enabled,
        script,
      );
      assert.equal(
        calls().some(
          (c) =>
            c.name === "docker" &&
            c.args.some((a) => a.includes("native-onboarding-health.js")),
        ),
        enabled,
        script,
      );
      checks++;
    }
  }
  reset("HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=true\n", { existing: true });
  assert.equal(
    run("recreate-services-no-build.sh", { SERVICES: "api" }).status,
    0,
  );
  assert.ok(
    !calls().some((c) =>
      c.args.some(
        (a) =>
          a === "hunch-native-onboarding-worker" ||
          a === "native-onboarding-worker",
      ),
    ),
    "explicit API-only repair must not manage native worker",
  );
  checks++;
  reset("", { existing: true });
  assert.equal(run("deploy-ec2-prebuilt.sh").status, 0);
  assert.ok(
    calls().some(
      (c) =>
        c.name === "docker" &&
        c.args[0] === "stop" &&
        c.args.at(-1) === "hunch-native-onboarding-worker",
    ),
  );
  checks++;
  for (const state of [
    { foreign: true, existing: true },
    { incompatible: true },
    { migrationFails: true },
  ]) {
    reset("HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=true\n", state);
    assert.notEqual(run("deploy-ec2-prebuilt.sh").status, 0);
    assert.ok(
      !calls().some(mutatesApplications),
      "failed preflight/migration must preserve running apps",
    );
    checks++;
  }
  reset("HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=invalid\n");
  assert.notEqual(run("deploy-ec2-prebuilt.sh").status, 0);
  assert.ok(!calls().some(mutatesApplications));
  checks++;
  reset("HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=true\n", {
    existing: true,
    wrongImage: true,
  });
  assert.notEqual(
    run("recreate-services-no-build.sh", {
      SERVICES: "native-onboarding-worker",
    }).status,
    0,
  );
  checks++;
  reset(
    "HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=true\nHUNCH_APNS_DELIVERY_ENABLED=true\n",
    { existing: true, deliveryNotReady: true },
  );
  assert.notEqual(
    run("recreate-services-no-build.sh", {
      SERVICES: "native-onboarding-worker",
    }).status,
    0,
  );
  assert.ok(calls().some((c) => c.args.includes("--require-delivery")));
  checks++;
  reset(
    "HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=true\nHUNCH_APNS_DELIVERY_ENABLED=false\n",
    { existing: true, deliveryNotReady: true },
  );
  assert.equal(
    run("recreate-services-no-build.sh", {
      SERVICES: "native-onboarding-worker",
    }).status,
    0,
  );
  assert.ok(!calls().some((c) => c.args.includes("--require-delivery")));
  checks++;
  reset(
    "HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=true\nHUNCH_APNS_DELIVERY_ENABLED=true\n",
    { existing: true, deliveryNotReady: true },
  );
  assert.notEqual(
    run("recreate-services-no-build.sh", { RESTART_NGINX: "1", VERIFY: "1" })
      .status,
    0,
  );
  const recoveryCalls = calls();
  const nginxRefresh = recoveryCalls.findIndex(
    (c) =>
      c.name === "docker" &&
      c.args[0] === "restart" &&
      c.args.includes("hunch-nginx"),
  );
  const apiHealth = recoveryCalls.findIndex((c) => c.name === "curl");
  const nativeReadiness = recoveryCalls.findIndex(
    (c) => c.name === "docker" && c.args.includes("--require-delivery"),
  );
  assert.ok(
    nginxRefresh >= 0 &&
      apiHealth > nginxRefresh &&
      nativeReadiness > apiHealth,
    "optional APNs readiness must follow nginx/API recovery",
  );
  checks++;
  for (const services of [
    "native-onboarding-worker\n",
    "api\nnative-onboarding-worker",
    "api\tnative-onboarding-worker",
    "",
  ]) {
    reset("HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=false\n");
    assert.notEqual(
      run("recreate-services-no-build.sh", { SERVICES: services }).status,
      0,
    );
    assert.ok(!calls().some(mutatesApplications));
    checks++;
  }
  reset("HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=true\n", { existing: true });
  assert.equal(
    run("recreate-services-no-build.sh", {
      SERVICES: "api\nnative-onboarding-worker",
    }).status,
    0,
  );
  assert.ok(
    calls().some(
      (c) =>
        c.name === "docker" &&
        c.args.some((a) => a.includes("native-onboarding-health.js")),
    ),
  );
  checks++;
  for (const ambient of ["native-onboarding", "*"]) {
    reset("HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED=false\n");
    assert.equal(
      run("restart-all.sh", { COMPOSE_PROFILES: ambient }).status,
      0,
    );
    const started = calls().find(
      (c) => c.name === "docker-compose" && c.args.includes("up"),
    );
    assert.ok(
      started.args.includes("api") &&
        !started.args.includes("native-onboarding-worker"),
    );
    checks++;
  }
  console.log(
    "native onboarding deploy: " +
      checks +
      " mocked checks passed; no real SSH/Docker/deploy executed",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
