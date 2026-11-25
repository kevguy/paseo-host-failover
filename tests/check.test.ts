import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { test } from "node:test";
import { checkRoute, classify, classifySsh } from "../server/check";
import { isTailnetAddress, reach, tailscaleUp } from "../server/network";
import { displayTarget, parseTarget } from "../server/target";

test("reads only ssh's own phrases", () => {
  for (const [text, code] of [["alex@h: Permission denied (publickey).", "ssh_denied"], ["Host key verification failed.", "ssh_host_key"], ["ssh: Could not resolve hostname h: nodename", "dns"],
    ["channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed", "daemon_down"], ["channel 0: open failed: administratively prohibited: open failed\nstdio forwarding failed", "ssh_failed"],
    ["ssh: connect to host h port 22: Operation timed out", "timeout"], ["ssh: connect to host h port 22: Connection refused", "refused"], ["Unauthorized access is prohibited. Permission denied to others.", null], ["Warning: added h to known hosts", null]] as const) assert.equal(classifySsh(text), code, text);
  assert.equal(classify("connect ECONNREFUSED 127.0.0.1:1"), "refused"); assert.equal(classify("401 unauthorized"), "unknown");
});
test("recognises tailnet addresses", () => {
  assert.ok(isTailnetAddress("100.64.0.1")); assert.ok(isTailnetAddress("fd7a:115c:a1e0::1"));
  assert.ok(!isTailnetAddress("100.128.0.1")); assert.ok(!isTailnetAddress("10.0.0.1"));
  const entry = (address: string) => ({ utun: [{ address } as never] });
  assert.ok(tailscaleUp(entry("100.100.1.2"))); assert.ok(!tailscaleUp(entry("192.168.1.2")));
});
test("targets keep no credential in what is shown", () => {
  assert.equal(displayTarget(parseTarget("ssh://alex@h:2222?daemonPort=7000").description), "SSH to h:2222 (daemon port 7000)");
  assert.equal(displayTarget(parseTarget("relay://relay.example:443/srv_x?key=abc").description), "Paseo relay (relay.example:443)");
  assert.equal(displayTarget(parseTarget("tcp://h:6767?password=pw").description), "Direct to h:6767");
  const offer = Buffer.from(JSON.stringify({ v: 2, serverId: "srv_x", daemonPublicKeyB64: "abc", relay: { endpoint: "relay.example:443", useTls: true } })).toString("base64url");
  assert.equal(parseTarget(`https://app.paseo.sh/#offer=${offer}`).serverId, "srv_x");
});
test("reach and checkRoute give up on refused and silent ports", async () => {
  const sockets: Socket[] = []; const server = createServer(socket => { sockets.push(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
  assert.ok(await reach({ host: "127.0.0.1", port }));
  assert.ok(!await reach({ host: "127.0.0.1", port, banner: true }, 300));
  const silent = await checkRoute({ connection: `tcp://127.0.0.1:${port}`, parsed: parseTarget(`tcp://127.0.0.1:${port}`), serverId: "srv", clientId: "t" }, 800);
  assert.equal(silent.ok, false); assert.equal(silent.code, "timeout"); assert.ok(silent.ms < 3000);
  sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve));
  assert.ok(!await reach({ host: "127.0.0.1", port }));
  const refused = await checkRoute({ connection: `tcp://127.0.0.1:${port}`, parsed: parseTarget(`tcp://127.0.0.1:${port}`), serverId: "srv", clientId: "t" }, 800);
  assert.equal(refused.ok, false); assert.equal(refused.code, "refused"); void connect;
});
