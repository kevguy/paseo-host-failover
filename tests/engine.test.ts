import assert from "node:assert/strict";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Engine } from "../server/engine";
import { Store } from "../server/store";
import { KEY, RELAY, SSH, World } from "./helpers";

test("fails over within 60 s after Paseo notices, and says why", async () => {
  const w = new World(); await w.setUp();
  w.down.set("ssh", "tailscale_off"); const start = w.time;
  while (!w.updates.length && w.time - start < 60_000) await w.tick();
  assert.deepEqual(w.updates, ["relay"]); assert.ok(w.time - start <= 20_000);
  await w.tick();
  const host = await w.host();
  assert.equal(host.headline, "Online by Relay");
  assert.match(host.events.map(e => e.text).join("\n"), /Switched to Relay\. Home SSH: Tailscale looks off/);
});
test("fails over before Paseo notices a dead link", async () => {
  const w = new World(); await w.setUp();
  w.noticed = false; w.down.set("ssh", "timeout"); w.unreachable.add("build-box"); const start = w.time;
  while (!w.updates.length && w.time - start < 60_000) await w.tick();
  assert.deepEqual(w.updates, ["relay"]); assert.ok(w.time - start <= 20_000);
});
test("an unreachable port alone does not switch a route that still works", async () => {
  const w = new World(); await w.setUp(); w.unreachable.add("build-box"); await w.run(60);
  assert.deepEqual(w.updates, []);
});
test("a probe that never worked is not evidence", async () => {
  const w = new World(); w.unreachable.add("build-box"); await w.setUp(); w.noticed = false; w.down.set("ssh", "timeout"); await w.run(60);
  assert.deepEqual(w.updates, []);
});
test("switches back only after the first route stays up", async () => {
  const w = new World(); await w.setUp(); w.down.set("ssh", "timeout"); await w.run(30);
  assert.deepEqual(w.updates, ["relay"]);
  w.down.delete("ssh"); await w.run(20); assert.deepEqual(w.updates, ["relay"]);
  await w.run(60); assert.deepEqual(w.updates, ["relay", "ssh"]);
  assert.equal((await w.host()).headline, "Online by Home SSH");
});
test("a flapping route is left alone for longer each time", async () => {
  const w = new World(); await w.setUp();
  for (let i = 0; i < 40; i += 1) { w.down.set("ssh", "timeout"); await w.run(30); w.down.delete("ssh"); await w.run(90); }
  assert.ok(w.updates.length < 30, `switched ${w.updates.length} times in 80 minutes`);
});
test("a refusing route is tried less and less often", async () => {
  const w = new World(); await w.setUp(); w.down.set("ssh", "ssh_denied"); await w.run(30); w.checks = [];
  await w.run(1800); assert.ok(w.checks.filter(kind => kind === "ssh").length < 15, String(w.checks.length));
});
test("manual mode never switches but still explains", async () => {
  const w = new World(); await w.setUp("manual"); w.down.set("ssh", "ssh_denied"); await w.run(120);
  assert.deepEqual(w.updates, []); assert.match((await w.host()).reason!, /SSH refused the login/);
});
test("never switches to a route that fails its test", async () => {
  const w = new World(); await w.setUp(); w.down.set("ssh", "timeout"); w.down.set("relay", "wrong_host"); await w.run(300);
  assert.deepEqual(w.updates, []);
  w.down.delete("relay"); await w.run(70); assert.deepEqual(w.updates, ["relay"]);
});
test("an old host says so and is not switched", async () => {
  const w = new World({ status: "offline", error: { code: "unsupported_capability", message: "x" } });
  w.down.set("ssh", "too_old"); await w.setUp(); await w.run(120);
  const host = await w.host();
  assert.equal(host.headline, "Too old to be a fleet host"); assert.match(host.reason!, /0\.13\.0 or later/); assert.deepEqual(w.updates, []);
});
test("duplicate and self hosts are left alone", async () => {
  for (const code of ["duplicate_host", "self_host"]) {
    const w = new World({ status: "error", error: { code, message: "x" } }); await w.setUp(); w.checks = []; await w.run(120);
    assert.deepEqual([w.updates, w.checks], [[], []]);
  }
});
test("a connection changed elsewhere is respected until a route is chosen", async () => {
  const w = new World(); await w.setUp(); w.summary.targetDescription = "tcp://elsewhere:6767"; w.connection = "tcp://elsewhere:6767"; w.down.set("direct", "timeout");
  await w.run(120); assert.deepEqual(w.updates, []);
  assert.ok((await w.host()).events.some(event => /changed outside/.test(event.text)));
  await w.engine.useRoute({ registrationId: "reg-1", routeId: (await w.host()).routes[1]!.id }); assert.deepEqual(w.updates, ["relay"]);
});
test("a replaced identity stops everything", async () => {
  const w = new World(); await w.setUp(); w.summary.serverId = "srv_other"; w.down.set("ssh", "timeout"); await w.run(120);
  assert.deepEqual(w.updates, []); assert.match((await w.host()).reason!, /different Paseo/);
});
test("choosing a route by hand tests it and turns automatic off", async () => {
  const w = new World(); await w.setUp(); const relay = (await w.host()).routes[1]!.id;
  w.down.set("relay", "relay");
  await assert.rejects(w.engine.useRoute({ registrationId: "reg-1", routeId: relay }), /Not switched/); assert.deepEqual(w.updates, []);
  w.down.delete("relay"); await w.engine.useRoute({ registrationId: "reg-1", routeId: relay }); await w.run(300);
  assert.deepEqual(w.updates, ["relay"]); assert.equal((await w.host()).mode, "manual");
});
test("saving refuses wrong, duplicate, unknown and unidentified routes", async () => {
  const w = new World(); await w.setUp(); const save = (connection: string, name = "Extra") => w.engine.saveRoute({ registrationId: "reg-1", name, connection });
  await assert.rejects(save("relay://relay.example:443/srv_other?key=abc"), /different computer/);
  await assert.rejects(save("ssh://other@build-box.example"), /already has a route to that address/);
  await assert.rejects(save("ftp://secret-value"), error => !String(error).includes("secret-value"));
  await assert.rejects(save("tcp://10.0.0.1:6767", "relay"), /that name/);
  const fresh = new World({ serverId: null }); await assert.rejects(fresh.engine.saveRoute({ registrationId: "reg-1", name: "A", connection: SSH }), /never connected/);
});
test("automatic needs two routes, and losing one turns it off", async () => {
  const w = new World(); await w.engine.saveRoute({ registrationId: "reg-1", name: "Home SSH", connection: SSH });
  await assert.rejects(w.engine.setMode({ registrationId: "reg-1", mode: "auto" }), /two routes/);
  await w.setUp().catch(() => {}); await w.engine.saveRoute({ registrationId: "reg-1", name: "Relay", connection: RELAY }).catch(() => {});
  await w.engine.setMode({ registrationId: "reg-1", mode: "auto" });
  await w.engine.removeRoute({ registrationId: "reg-1", routeId: (await w.host()).routes[1]!.id }); assert.equal((await w.host()).mode, "manual");
});
test("no connection string is ever returned", async () => {
  const w = new World(); await w.setUp(); const outputs: unknown[] = [await w.engine.state()];
  const relay = (await w.host()).routes[1]!.id;
  outputs.push(await w.engine.testRoutes({ registrationId: "reg-1" }), await w.engine.saveRoute({ registrationId: "reg-1", routeId: relay, name: "Away" }));
  w.down.set("ssh", "timeout"); await w.run(60); outputs.push(await w.engine.state(), await w.engine.preferRoute({ registrationId: "reg-1", routeId: relay }));
  await w.engine.saveRoute({ registrationId: "reg-1", name: "Direct", connection: "tcp://build-box.example:6767?password=PLANTEDPASSWORD" }); outputs.push(await w.engine.state());
  const text = JSON.stringify(outputs);
  for (const secret of [KEY, encodeURIComponent(KEY), "PLANTED", "alex@", "srv_build?", "key="]) assert.ok(!text.includes(secret), secret);
  const file = join(w.dir, "routes.json");
  assert.ok(readFileSync(file, "utf8").includes("PLANTEDPASSWORD")); // Windows has no file modes.
  if (process.platform !== "win32") { assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(w.dir).mode & 0o777, 0o700); }
});
test("routes survive a restart and a damaged file is never replaced", async () => {
  const w = new World(); await w.setUp(); const again = new Store(w.dir); assert.equal((await again.load())[0]!.routes.length, 2);
  const file = join(w.dir, "routes.json"); writeFileSync(file, "{broken"); const broken = new Store(w.dir);
  await assert.rejects(broken.edit(() => []), /damaged/); assert.equal(readFileSync(file, "utf8"), "{broken");
});
test("a stopped engine does not switch", async () => {
  const w = new World(); await w.setUp(); w.engine.stop(); w.down.set("ssh", "timeout"); await w.run(60); assert.deepEqual(w.updates, []);
  assert.ok(w.engine instanceof Engine);
});
test("a removed host keeps its routes until forgotten", async () => {
  const w = new World(); await w.setUp(); w.summary.registrationId = "reg-2";
  const orphan = (await w.engine.state()).hosts.find(host => host.registrationId === "reg-1")!; assert.equal(orphan.headline, "No longer a connected host");
  await w.engine.forget({ registrationId: "reg-1" }); assert.ok(!readFileSync(join(w.dir, "routes.json"), "utf8").includes("PLANTED"));
});

// ---- found by the first review ----
test("a save during a concurrent first load is never lost", async () => {
  for (let i = 0; i < 25; i += 1) {
    const w = new World(); await new Store(w.dir).edit(() => [{ registrationId: "reg-0", serverId: "srv_x", mode: "manual", routes: [], events: [] }]);
    const polls = [w.engine.tick(), w.engine.state(), w.engine.state()];
    await w.engine.saveRoute({ registrationId: "reg-1", name: "Home SSH", connection: SSH }); await Promise.all(polls);
    assert.equal((await new Store(w.dir).load())[1]?.routes.length, 1);
  }
});
test("concurrent edits from two stores and a failing edit lose nothing", async () => {
  const w = new World(); await w.setUp(); const other = new Store(w.dir);
  const add = (store: Store, text: string) => store.edit(hosts => { hosts[0]!.events.unshift({ at: 1, text }); });
  await add(w.store, "one"); await add(other, "two");
  const results = await Promise.allSettled([add(w.store, "three"), w.store.edit(() => { throw new Error("no"); }), add(w.store, "four")]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected", "fulfilled"]);
  const texts = (await other.load())[0]!.events.map(e => e.text); for (const text of ["one", "two", "three", "four"]) assert.ok(texts.includes(text), text);
});
test("a leftover pending file is removed by the next save", async () => {
  const w = new World(); await w.setUp(); const left = join(w.dir, ".routes-old"); writeFileSync(left, KEY); utimesSync(left, 1, 1);
  await w.store.edit(() => {}); assert.throws(() => statSync(left));
});
test("connects again when Paseo gave up on a route that works", async () => {
  const w = new World(); await w.setUp(); w.stuck = true; await w.run(25); assert.deepEqual(w.updates, []); await w.run(30);
  assert.deepEqual(w.updates, ["ssh"]); assert.equal((await w.host()).headline, "Online by Home SSH");
});
test("leaves a route that passes its test but never connects, without rapid switching", async () => {
  const w = new World(); await w.setUp(); w.unusable.add("ssh"); await w.run(75);
  assert.deepEqual(w.updates, ["ssh", "relay"]); assert.equal((await w.host()).headline, "Online by Relay");
  await w.run(3600); assert.ok(w.updates.length <= 14, `${w.updates.length} switches in an hour`);
  const both = new World(); await both.setUp(); both.unusable.add("ssh"); both.unusable.add("relay"); await both.run(3600);
  assert.ok(both.updates.length < 40, `${both.updates.length} switches in an hour`);
  both.unusable.clear(); await both.run(1900); assert.equal((await both.host()).status, "online");
});
test("a refused login is retried less and less often in both modes", async () => {
  for (const mode of ["auto", "manual"] as const) {
    const w = new World(); await w.setUp(mode); w.down.set("ssh", "ssh_denied"); w.down.set("relay", "relay"); w.checks = []; await w.run(1800);
    assert.ok(w.checks.filter(kind => kind === "ssh").length <= 7, `${mode} ${w.checks.filter(kind => kind === "ssh").length}`);
  }
});
test("backs off when every route fails while Paseo still says online", async () => {
  const w = new World(); await w.setUp(); w.noticed = false; w.unreachable.add("build-box"); w.down.set("ssh", "timeout"); w.down.set("relay", "relay"); w.checks = [];
  await w.run(300); assert.ok(w.checks.filter(kind => kind === "ssh").length <= 9, String(w.checks.length));
});
test("editing the route in use gives Paseo the new link", async () => {
  const w = new World({ targetDescription: "relay://relay.example:443/srv_build" }); w.connection = RELAY;
  await w.engine.saveRoute({ registrationId: "reg-1", name: "Relay", connection: RELAY }); const id = (await w.host()).routes[0]!.id;
  const fresh = RELAY.replace("PLANTED", "REPAIRED");
  await w.engine.saveRoute({ registrationId: "reg-1", routeId: id, name: "Relay", connection: fresh }); assert.deepEqual(w.connections, [fresh]);
  await w.engine.saveRoute({ registrationId: "reg-1", routeId: id, name: "Renamed" }); assert.equal(w.connections.length, 1);
});
test("a failed switch by hand leaves automatic on; connecting again keeps it", async () => {
  const w = new World(); await w.setUp(); const [ssh, relay] = (await w.host()).routes;
  await assert.rejects(w.engine.useRoute({ registrationId: "reg-1", routeId: ssh!.id }), /already uses/);
  w.summary.status = "offline"; w.stuck = true; await w.engine.useRoute({ registrationId: "reg-1", routeId: ssh!.id }); assert.equal((await w.host()).mode, "auto");
  w.down.set("relay", "relay"); await assert.rejects(w.engine.useRoute({ registrationId: "reg-1", routeId: relay!.id })); assert.equal((await w.host()).mode, "auto");
  w.down.clear(); w.refuseUpdate = true; await assert.rejects(w.engine.useRoute({ registrationId: "reg-1", routeId: relay!.id }), /Not switched/); assert.equal((await w.host()).mode, "auto");
});
test("removing the route in use turns automatic off and says why nothing happens", async () => {
  const w = new World(); await w.setUp(); await w.engine.saveRoute({ registrationId: "reg-1", name: "Direct", connection: "tcp://build-box.example:6767" });
  await w.engine.removeRoute({ registrationId: "reg-1", routeId: (await w.host()).routes[0]!.id });
  w.down.set("ssh", "timeout"); await w.run(30); const host = await w.host(); assert.equal(host.mode, "manual"); assert.match(host.reason!, /not one of the saved routes/);
});
test("one unreadable route does not hide the others, and duplicates keep their reason", async () => {
  const w = new World(); await w.setUp(); await w.store.edit(hosts => { hosts[0]!.routes.push({ id: "x", name: "Broken", connection: "nonsense" }); });
  await w.engine.testRoutes({ registrationId: "reg-1" }); const host = await w.host(); assert.equal(host.routes[2]!.target, "Unreadable connection"); assert.match(host.routes[2]!.check!.reason!, /cannot be read/);
  w.down.set("ssh", "timeout"); await w.run(30); assert.deepEqual(w.updates, ["relay"]);
  Object.assign(w.summary, { status: "error", error: { code: "duplicate_host", message: "x" } }); await w.run(10); assert.match((await w.host()).reason!, /already reaches/);
});

// ---- found by the second review ----
test("a link that comes back during the tests is left alone", async () => {
  const back = (w: World) => { w.noticed = false; w.summary.status = "offline"; w.during = () => { w.summary.status = "online"; }; };
  const w = new World(); await w.setUp(); w.down.set("ssh", "timeout"); back(w); await w.run(15); assert.deepEqual(w.updates, []); assert.ok(w.checks.length > 3);
  const again = new World(); await again.setUp(); back(again); const [ssh, relay] = (await again.host()).routes; again.summary.status = "offline";
  await assert.rejects(again.engine.useRoute({ registrationId: "reg-1", routeId: ssh!.id }), /came back/); assert.deepEqual(again.updates, []);
  back(again); await again.engine.useRoute({ registrationId: "reg-1", routeId: relay!.id }); assert.deepEqual(again.updates, ["relay"]);
});
test("a route removed, a mode changed or a host changed during the tests stops the switch", async () => {
  for (const change of ["remove", "manual", "edit", "target", "identity", "disabled", "stop"] as const) {
    const w = new World(); await w.setUp(); w.down.set("ssh", "timeout");
    w.during = async () => {
      w.during = null;
      if (change === "remove") await w.store.edit(hosts => { hosts[0]!.routes.pop(); });
      if (change === "edit") await w.store.edit(hosts => { hosts[0]!.routes[1]!.connection = RELAY.replace("PLANTED", "REPAIRED"); });
      if (change === "manual") await w.store.edit(hosts => { hosts[0]!.mode = "manual"; });
      if (change === "target") w.summary.targetDescription = "tcp://elsewhere:1";
      if (change === "identity") w.summary.serverId = "srv_other";
      if (change === "disabled") w.summary.enabled = false;
      if (change === "stop") w.engine.stop();
    };
    await w.run(20); assert.deepEqual(w.updates, [], change);
  }
});
test("a request that finishes before a queued tick is respected", async () => {
  for (let i = 0; i < 20; i += 1) {
    const w = new World(); await w.setUp(); w.down.set("ssh", "timeout"); await w.tick(); w.time += 10_000; const relay = (await w.host()).routes[1]!.id;
    const removing = w.engine.removeRoute({ registrationId: "reg-1", routeId: relay }); await Promise.all([w.engine.tick(), removing]); await w.engine.lastWork; await w.run(30);
    assert.deepEqual(w.updates, []);
  }
});
test("a drop is always tested afresh before leaving the route", async () => {
  const w = new World(); await w.setUp(); w.down.set("ssh", "ssh_denied"); await w.run(20); assert.deepEqual(w.updates, ["relay"]);
  w.down.delete("ssh"); await w.engine.useRoute({ registrationId: "reg-1", routeId: (await w.host()).routes[0]!.id }); await w.run(10); await w.engine.setMode({ registrationId: "reg-1", mode: "auto" });
  w.checks = []; w.down.set("ssh", "timeout"); await w.run(20); assert.ok(w.checks.includes("ssh")); assert.equal(w.updates.at(-1), "relay");
});
test("a failed write during a switch by hand does not switch", async () => {
  const w = new World(); await w.setUp(); const relay = (await w.host()).routes[1]!.id;
  const real = w.store.edit.bind(w.store); w.store.edit = async () => { throw new Error("The routes could not be saved."); };
  await assert.rejects(w.engine.useRoute({ registrationId: "reg-1", routeId: relay })); assert.deepEqual(w.updates, []); w.store.edit = real;
});
test("an edit that Paseo does not have yet is shown and can be sent", async () => {
  const w = new World(); await w.setUp(); const ssh = (await w.host()).routes[0]!.id; w.refuseUpdate = true;
  await assert.rejects(w.engine.saveRoute({ registrationId: "reg-1", routeId: ssh, name: "Home SSH", connection: "ssh://sam@build-box.example" }), /still uses the old connection/);
  assert.equal((await w.host()).routes[0]!.edited, true); w.refuseUpdate = false;
  await w.engine.useRoute({ registrationId: "reg-1", routeId: ssh }); assert.deepEqual(w.connections, ["ssh://sam@build-box.example"]);
  const host = await w.host(); assert.equal(host.routes[0]!.edited, false); assert.equal(host.mode, "auto");
});
test("moving the route in use to another address turns automatic off", async () => {
  const w = new World(); await w.setUp(); await w.engine.saveRoute({ registrationId: "reg-1", routeId: (await w.host()).routes[0]!.id, name: "Home SSH", connection: "ssh://alex@other.example" });
  assert.equal((await w.host()).mode, "manual"); assert.deepEqual(w.updates, []);
});
test("a duplicate keeps its reason after a failed test", async () => {
  const w = new World(); await w.setUp("manual"); w.down.set("ssh", "timeout"); await w.run(20);
  Object.assign(w.summary, { status: "error", error: { code: "duplicate_host", message: "x" } }); await w.run(10); assert.match((await w.host()).reason!, /already reaches/);
});
test("automatic stays on when Paseo stops answering during a switch by hand", async () => {
  const w = new World(); await w.setUp(); const relay = (await w.host()).routes[1]!.id; w.during = () => { w.listFails = true; };
  await assert.rejects(w.engine.useRoute({ registrationId: "reg-1", routeId: relay }), /Not switched/);
  w.listFails = false; assert.equal((await w.host()).mode, "auto"); assert.deepEqual(w.updates, []);
});
test("any failed test restarts the count of three before switching back", async () => {
  const w = new World(); await w.setUp(); w.down.set("ssh", "timeout"); await w.run(30); assert.deepEqual(w.updates, ["relay"]);
  w.down.delete("ssh"); w.checks = []; const passes = () => w.checks.filter(kind => kind === "ssh").length;
  while (passes() < 2) await w.tick();
  w.down.set("ssh", "timeout"); await w.engine.testRoutes({ registrationId: "reg-1" }); w.down.delete("ssh"); w.checks = [];
  while (passes() < 2) await w.tick();
  assert.deepEqual(w.updates, ["relay"]); while (passes() < 3) await w.tick(); assert.deepEqual(w.updates, ["relay", "ssh"]);
});
