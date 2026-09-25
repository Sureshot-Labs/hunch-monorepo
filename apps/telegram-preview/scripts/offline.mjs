import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const forbidden = () => {
  throw new Error("Network access is forbidden during snapshot generation.");
};
globalThis.fetch = forbidden;
net.Socket.prototype.connect = forbidden;
tls.connect = forbidden;

// Renderers use the current time and random callback IDs. Freeze only this
// subprocess so regeneration produces a reviewable, deterministic diff.
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) {
    super(...(args.length ? args : ["2026-09-23T12:00:00.000Z"]));
  }
  static now() {
    return 1790164800000;
  }
};
let sequence = 0;
crypto.randomUUID = () =>
  `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
syncBuiltinESMExports();
