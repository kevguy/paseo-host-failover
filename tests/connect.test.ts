import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { checkRoute } from "../server/check";
import { parseTarget } from "../server/target";
import { directory } from "./helpers";

async function daemon(payload: object | null, reject = false) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise(resolve => wss.once("listening", resolve));
  wss.on("connection", socket => socket.on("message", () => {
    if (payload) socket.send(JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info", ...payload } } }));
    if (reject) { socket.send(JSON.stringify({ type: "hello.rejected", reason: "incorrect_password", accepts: ["password"] })); socket.close(4001, "no"); }
  }));
  const connection = `tcp://127.0.0.1:${(wss.address() as { port: number }).port}?password=PLANTEDPASSWORD`;
  const result = await checkRoute({ connection, parsed: parseTarget(connection), serverId: "srv_good", clientId: "t" }, 1200);
  await new Promise(resolve => setTimeout(resolve, 100));
  const left = wss.clients.size;
  wss.clients.forEach(socket => socket.terminate()); await new Promise(resolve => wss.close(resolve));
  assert.equal(left, 0, "a test left a connection open"); assert.ok(!JSON.stringify(result).includes("PLANTED"));
  return result;
}
const features = { connectedHosts: true, hostMultiplexing: true };

test("a test checks identity, version and login", async () => {
  const good = await daemon({ serverId: "srv_good", version: "0.17.4", features }); assert.deepEqual([good.ok, good.version], [true, "0.17.4"]);
  assert.equal((await daemon({ serverId: "srv_bad", version: "0.17.4", features })).code, "wrong_host");
  assert.equal((await daemon({ serverId: "srv_bad", version: "0.12.0", features: {} })).code, "wrong_host");
  const old = await daemon({ serverId: "srv_good", version: "0.12.0", features: {} }); assert.equal(old.code, "too_old"); assert.match(old.reason!, /0\.12\.0.*0\.13\.0 or later/);
  assert.equal((await daemon(null, true)).code, "auth"); assert.equal((await daemon(null)).code, "timeout");
});
test("ssh failures give their real reason and leave no process", async () => {
  const dir = directory(); const pids = join(dir, "pids"); writeFileSync(pids, "");
  // A stand-in ssh: -G answers with nothing, otherwise it fails with the given error.
  writeFileSync(join(dir, "ssh"), `#!/bin/sh\n[ "$1" = "-G" ] && exit 0\necho $$ >> "${pids}"\n[ "$FAKE_SSH" = banner-hang ] && echo "Unauthorized access is prohibited." >&2 && exec sleep 30\n[ "$FAKE_SSH" = hang ] && exec sleep 30\necho "$FAKE_SSH" >&2\nexit 255\n`);
  chmodSync(join(dir, "ssh"), 0o755);
  const path = process.env.PATH; process.env.PATH = `${dir}:${path}`;
  try {
    for (const [text, code] of [["alex@h: Permission denied (publickey).", "ssh_denied"], ["Host key verification failed.", "ssh_host_key"], ["ssh: Could not resolve hostname h", "dns"],
      ["channel 0: open failed: connect failed: Connection refused", "daemon_down"], ["ssh: connect to host h port 22: Connection refused", "refused"], ["ssh: connect to host h port 22: No route to host", "unreachable"], ["Unauthorized access is prohibited.", "ssh_failed"], ["banner-hang", "timeout"], ["hang", "timeout"]] as const) {
      process.env.FAKE_SSH = text; const connection = "ssh://alex@build-box.example?password=PLANTEDPASSWORD";
      const result = await checkRoute({ connection, parsed: parseTarget(connection), serverId: "srv", clientId: "t" }, 1200);
      assert.equal(result.code, code, text); assert.ok(!JSON.stringify(result).includes("PLANTED"));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    const started = readFileSync(pids, "utf8").trim().split("\n").map(Number); assert.equal(started.length, 9);
    for (const pid of started) assert.throws(() => process.kill(pid, 0), `ssh ${pid} still runs`);
  } finally { process.env.PATH = path; delete process.env.FAKE_SSH; }
});
