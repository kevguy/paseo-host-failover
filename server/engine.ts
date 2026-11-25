import { randomUUID } from "node:crypto";
import type { HostDirectory, HostSummary } from "@getpaseo/protocol/hosts";
import { MAX_ROUTES, type Check, type FailureCode, type Host, type Mode, type State } from "../shared/contract";
import { checkRoute, reasonFor, type Target } from "./check";
import * as network from "./network";
import { Store, type SavedHost, type SavedRoute } from "./store";
import { UserError, displayTarget, parseTarget, tryParse, type Parsed } from "./target";

export interface HostsApi {
  list(): Promise<HostDirectory>;
  update(registrationId: string, patch: { connection: string }): Promise<HostSummary>;
}
export interface Deps {
  hosts: HostsApi;
  store(serverId: string): Store;
  check(target: Target): Promise<Check>;
  reach(endpoint: network.Endpoint): Promise<boolean>;
  endpointOf(parsed: Parsed): Promise<network.Endpoint | null>;
  onTailnet(endpoint: network.Endpoint | null): Promise<boolean>;
  tailscaleUp(): boolean;
  now(): number;
}
export const realDeps = (hosts: HostsApi): Deps => ({
  hosts, store: Store.for, check: checkRoute, reach: network.reach, endpointOf: network.endpointOf,
  onTailnet: network.onTailnet, tailscaleUp: network.tailscaleUp, now: Date.now,
});

const S = 1000, MIN = 60 * S;
const GRACE = 5 * S, RETRYING = 30 * S, SETTLE = 20 * S, COOL = MIN, BACK_EVERY = 15 * S, PROBE_EVERY = 10 * S, BACK_PASSES = 3;
const FLAP_WINDOW = 30 * MIN, MAX_HOLD = 30 * MIN, VERSION_EVERY = 6 * 60 * MIN, MAX_EVENTS = 40;

interface Runtime {
  activeId: string | null; status: string | null; description: string | null; routeSince: number | null; since: number | null; downSince: number | null;
  reachOk: boolean; reachFails: number; nextReachAt: number;
  endpoints: Map<string, { at: number; value: network.Endpoint | null }>;
  checks: Map<string, Check>; version: string | null;
  nextCheckAt: number; backoff: number; nextVersionAt: number;
  pending: { routeId: string; at: number } | null;
  /** Routes that passed a test but did not bring the host online, or whose login was refused. */
  cooling: Map<string, { until: number; times: number }>; refused: Map<string, { until: number; times: number }>;
  nextBackAt: number; backFails: number; passes: Map<string, number>; lastBackAt: number; hold: number;
  /** Routes in use whose edited connection Paseo does not have yet. */
  edited: Set<string>;
  hint: string | null;
  queue: Promise<unknown>; busy: boolean;
}
const runtime = (): Runtime => ({
  activeId: null, status: null, description: null, routeSince: null, since: null, downSince: null, reachOk: false, reachFails: 0, nextReachAt: 0, endpoints: new Map(),
  checks: new Map(), version: null, nextCheckAt: 0, backoff: 0, nextVersionAt: 0, pending: null, cooling: new Map(), refused: new Map(),
  nextBackAt: 0, backFails: 0, passes: new Map(), lastBackAt: 0, hold: 0, edited: new Set(), hint: null, queue: Promise.resolve(), busy: false,
});

const errorCodes: Record<string, FailureCode> = {
  authentication_failed: "auth", server_id_mismatch: "wrong_host", unsupported_capability: "too_old",
};
const refusals = new Set<FailureCode | null>(["auth", "ssh_denied", "ssh_host_key"]);
const grow = (map: Map<string, { until: number; times: number }>, id: string, now: number, base: number, max: number) => {
  const times = (map.get(id)?.times ?? 0) + 1;
  map.set(id, { until: now + Math.min(max, base * 2 ** Math.min(10, times - 1)), times });
};
const held = (map: Map<string, { until: number; times: number }>, id: string, now: number) => now < (map.get(id)?.until ?? 0);
const noAction = new Set(["self_host", "duplicate_host"]);

export class Engine {
  private runtimes = new Map<string, Runtime>();
  private directory: HostDirectory | null = null;
  private store: Store | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  constructor(private deps: Deps) {}

  start(everyMs = 5000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    (this.timer as { unref?(): void }).unref?.();
    void this.tick();
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); }

  private rt(id: string): Runtime {
    let found = this.runtimes.get(id);
    if (!found) this.runtimes.set(id, found = runtime());
    return found;
  }
  private async refresh(): Promise<{ directory: HostDirectory; saved: SavedHost[] }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const directory = await Promise.race([
        this.deps.hosts.list(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Paseo did not answer")), 10 * S); }),
      ]);
      this.store ??= this.deps.store(directory.self.serverId);
      const saved = await this.store.load();
      this.directory = directory;
      return { directory, saved };
    } finally { clearTimeout(timer); }
  }

  /** Runs work for one host at a time, so a manual switch and an automatic one cannot overlap. */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const rt = this.rt(id);
    const next = rt.queue.catch(() => {}).then(async () => { rt.busy = true; try { return await work(); } finally { rt.busy = false; } });
    rt.queue = next.catch(() => {});
    return next;
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    let work: Promise<unknown>[] = [];
    try {
      const { directory } = await this.refresh();
      work = directory.hosts.filter(host => !this.rt(host.registrationId).busy).map(host =>
        this.serial(host.registrationId, async () => {
          // Read again inside the queue: a request may have changed the host, its routes or its mode meanwhile.
          const fresh = await this.refresh();
          const current = fresh.directory.hosts.find(item => item.registrationId === host.registrationId);
          if (current) await this.tickHost(current, fresh.saved.find(item => item.registrationId === host.registrationId) ?? null);
        }).catch(() => {}));
    } catch { /* The next tick tries again; the panel reports a failed read by itself. */ }
    finally { this.ticking = false; }
    // A slow host must not delay the others, so only tests wait for this.
    this.lastWork = Promise.all(work);
  }
  lastWork: Promise<unknown> = Promise.resolve();

  private active(host: HostSummary, saved: SavedHost | null): SavedRoute | null {
    return saved?.routes.find(route => tryParse(route.connection)?.description === host.targetDescription) ?? null;
  }
  private async endpoint(rt: Runtime, route: SavedRoute): Promise<network.Endpoint | null> {
    const cached = rt.endpoints.get(route.id);
    if (cached && this.deps.now() - cached.at < MIN) return cached.value;
    const parsed = tryParse(route.connection);
    const value = parsed ? await this.deps.endpointOf(parsed).catch(() => null) : null;
    rt.endpoints.set(route.id, { at: this.deps.now(), value });
    return value;
  }
  private async check(host: HostSummary, rt: Runtime, route: SavedRoute): Promise<Check> {
    const parsed = tryParse(route.connection);
    const result: Check = !parsed ? { at: this.deps.now(), ok: false, code: "unknown", reason: "This saved connection cannot be read. Edit or remove it.", version: null, ms: 0 } : await this.deps.check({
      connection: route.connection, parsed, serverId: host.serverId!,
      clientId: `host-failover-${this.directory!.self.serverId}-${route.id}`,
    });
    rt.checks.set(route.id, result);
    if (refusals.has(result.code)) grow(rt.refused, route.id, this.deps.now(), MIN, 10 * MIN); else rt.refused.delete(route.id);
    if (result.version) rt.version = result.version;
    return result;
  }
  private async note(id: string, text: string): Promise<void> {
    await this.store!.edit(hosts => {
      const host = hosts.find(item => item.registrationId === id);
      if (host) host.events = [{ at: this.deps.now(), text }, ...host.events].slice(0, MAX_EVENTS);
    }).catch(() => {});
  }

  private async observe(host: HostSummary, saved: SavedHost | null, rt: Runtime, active: SavedRoute | null): Promise<void> {
    const now = this.deps.now();
    if (rt.description !== host.targetDescription) {
      const first = rt.description === null;
      rt.description = host.targetDescription; rt.routeSince = first ? null : now;
      rt.reachOk = false; rt.reachFails = 0; rt.passes.clear();
      if (!first && saved && !active) await this.note(host.registrationId, "The connection was changed outside Host Failover. It will leave this host alone until you choose a route.");
    }
    rt.activeId = active?.id ?? null;
    const status = host.status === "online" || host.status === "disabled" ? host.status : "down";
    if (rt.status !== status) {
      const previous = rt.status;
      rt.status = status;
      rt.since = previous === null ? null : now;
      if (status === "online") { rt.downSince = null; rt.backoff = 0; rt.nextCheckAt = 0; rt.nextVersionAt = 0; rt.hint = null; if (active) rt.cooling.delete(active.id); }
      if (status === "online" && previous !== null && saved) await this.note(host.registrationId, active ? `Online by ${active.name}.` : "Online.");
      if (status === "down" && previous === "online" && saved && !rt.pending) await this.note(host.registrationId, active ? `Lost ${active.name}.` : "Lost the connection.");
    }
    if (status === "down") rt.downSince ??= now;
  }

  private async tickHost(host: HostSummary, saved: SavedHost | null): Promise<void> {
    const rt = this.rt(host.registrationId);
    const now = this.deps.now();
    const active = this.active(host, saved);
    await this.observe(host, saved, rt, active);
    if (host.status === "disabled") { rt.pending = null; return; }
    if (host.status !== "online") await this.explain(host, rt, active);
    // Nothing is tested or switched without a pinned identity that still matches the saved one.
    if (!saved || !host.serverId || saved.serverId !== host.serverId || noAction.has(host.error?.code ?? "")) return;
    if (!active) return;
    if (host.status === "online") {
      rt.pending = null;
      if (saved.mode === "auto" && saved.routes.length > 1) {
        const endpoint = await this.endpoint(rt, active);
        if (endpoint && now >= rt.nextReachAt) {
          // Every other tick while healthy, so an SSH server is not asked more than needed.
          rt.nextReachAt = now + PROBE_EVERY;
          if (await this.deps.reach(endpoint)) { rt.reachOk = true; rt.reachFails = 0; }
          else if (rt.reachOk) { rt.reachFails += 1; rt.nextReachAt = 0; }
        }
        if (rt.reachFails >= 2 && now >= rt.nextCheckAt) { await this.recover(host, saved, rt, active); return; }
      }
      if (now >= rt.nextVersionAt) { rt.nextVersionAt = now + VERSION_EVERY; await this.check(host, rt, active); }
      if (saved.mode === "auto") await this.considerBack(host, saved, rt, active);
      return;
    }
    if (rt.pending) {
      if (now - rt.pending.at < SETTLE) return;
      grow(rt.cooling, rt.pending.routeId, now, COOL, MAX_HOLD);
      rt.pending = null;
      await this.note(host.registrationId, `${active.name} did not bring the host online in time.`);
    }
    if (now - (rt.downSince ?? now) < GRACE || now < rt.nextCheckAt) return;
    await this.recover(host, saved, rt, active);
  }

  private later(rt: Runtime): void {
    rt.backoff = Math.min(MIN, rt.backoff ? rt.backoff * 2 : 15 * S);
    rt.nextCheckAt = this.deps.now() + rt.backoff;
  }

  private async recover(host: HostSummary, saved: SavedHost, rt: Runtime, active: SavedRoute): Promise<void> {
    const automatic = saved.mode === "auto" && host.error?.code !== "unsupported_capability";
    const tried = automatic ? saved.routes : [active];
    const now = this.deps.now();
    const results = new Map<string, Check>();
    // A refused login is asked again less and less often, so a login guard is not tripped.
    await Promise.all(tried.map(async route => {
      const last = rt.checks.get(route.id);
      results.set(route.id, last && held(rt.refused, route.id, now) && (route.id !== active.id || last.at >= (rt.downSince ?? Infinity)) ? last : await this.check(host, rt, route));
    }));
    const current = results.get(active.id)!;
    if (current.ok && host.status === "online") { rt.reachOk = false; rt.reachFails = 0; rt.nextCheckAt = now + 15 * S; return; }
    if (!automatic || current.code === "too_old") { this.later(rt); return; }
    // The route works but Paseo is not using it (it stops for good after a refusal): connect again once,
    // and if that did not help either, treat the route as failed.
    if (current.ok && !held(rt.cooling, active.id, now)) {
      // Paseo's own retry comes first, unless it has stopped trying.
      if (host.status !== "error" && now - (rt.downSince ?? now) < RETRYING) { rt.nextCheckAt = now + 10 * S; return; }
      if (!await this.apply("auto", host, rt, active, "It works again")) this.later(rt);
      return;
    }
    const next = saved.routes.find(route => route.id !== active.id && results.get(route.id)!.ok && !held(rt.cooling, route.id, now));
    if (!next) { this.later(rt); return; }
    if (!await this.apply("auto", host, rt, next, `${active.name}: ${current.reason ?? "the test passed, but Paseo could not connect"}`)) { this.later(rt); return; }
    if (now - rt.lastBackAt < FLAP_WINDOW) rt.hold = Math.min(MAX_HOLD, Math.max(MIN, rt.hold * 2));
    else if (now - rt.lastBackAt > 2 * MAX_HOLD) rt.hold = 0;
    rt.nextBackAt = now + Math.max(BACK_EVERY, rt.hold);
  }

  private async considerBack(host: HostSummary, saved: SavedHost, rt: Runtime, active: SavedRoute): Promise<void> {
    const now = this.deps.now();
    if (now < rt.nextBackAt) return;
    rt.nextBackAt = now + BACK_EVERY;
    for (const route of saved.routes.slice(0, saved.routes.findIndex(item => item.id === active.id))) {
      if (held(rt.cooling, route.id, now) || held(rt.refused, route.id, now)) continue;
      const endpoint = await this.endpoint(rt, route);
      // The cheap look saves a login attempt every few seconds while the route is down.
      if (endpoint && !await this.deps.reach(endpoint)) { rt.passes.delete(route.id); continue; }
      if (!(await this.check(host, rt, route)).ok) {
        // Reachable but refused: try less and less often, so a login guard is not tripped.
        rt.passes.delete(route.id);
        rt.nextBackAt = now + Math.min(5 * MIN, BACK_EVERY * 2 ** Math.min(5, ++rt.backFails));
        continue;
      }
      rt.backFails = 0;
      const passes = (rt.passes.get(route.id) ?? 0) + 1;
      rt.passes.set(route.id, passes);
      if (passes < BACK_PASSES) return;
      rt.passes.clear();
      if (await this.apply("auto", host, rt, route, `${route.name} works again`)) rt.lastBackAt = this.deps.now();
      return;
    }
  }

  /** The only place a connection is changed. The caller has just tested this route. */
  private async apply(by: "auto" | "again" | "hand" | "edit", judged: HostSummary, rt: Runtime, route: SavedRoute, why: string): Promise<boolean> {
    const { directory, saved } = await this.refresh();
    const host = directory.hosts.find(item => item.registrationId === judged.registrationId);
    const entry = saved.find(item => item.registrationId === judged.registrationId);
    if (entry?.routes.find(item => item.id === route.id)?.connection !== route.connection || (by === "auto" && entry.mode !== "auto")) return false;
    if (this.stopped || !host || !host.enabled || host.serverId !== judged.serverId || host.targetDescription !== judged.targetDescription) return false;
    // The link came back while the routes were tested, so it is left alone.
    if ((by === "auto" || by === "again") && judged.status !== "online" && host.status === "online") return false;
    const before = rt.description;
    const again = host.targetDescription === parseTarget(route.connection).description;
    // Set first: the next status reading can arrive before update() returns.
    rt.pending = { routeId: route.id, at: this.deps.now() };
    try { await this.deps.hosts.update(host.registrationId, { connection: route.connection }); } catch {
      rt.pending = null; rt.description = before;
      await this.note(host.registrationId, `Paseo did not accept the switch to ${route.name}.`);
      return false;
    }
    rt.edited.delete(route.id);
    rt.description = parseTarget(route.connection).description;
    rt.routeSince = this.deps.now(); rt.activeId = route.id;
    rt.reachOk = false; rt.reachFails = 0; rt.passes.clear(); rt.backFails = 0;
    rt.status = "down"; rt.downSince = this.deps.now(); rt.since = this.deps.now();
    await this.note(host.registrationId, `${again ? "Connected again by" : "Switched to"} ${route.name}. ${why.replace(/\.$/, "")}.`);
    return true;
  }

  private async explain(host: HostSummary, rt: Runtime, active: SavedRoute | null): Promise<void> {
    const code = host.error?.code ?? "";
    rt.hint = code === "duplicate_host" ? "Another saved host already reaches this computer. Remove one of them."
      : code === "self_host" ? "This connection reaches this computer itself."
      : code === "authentication_failed" && host.targetDescription.startsWith("ssh://") ? "SSH refused the login or does not trust the host key, so Paseo stopped trying."
      : errorCodes[code] ? reasonFor(errorCodes[code], errorCodes[code] === "too_old" ? rt.version : null) : null;
    if (rt.hint || this.deps.tailscaleUp()) return;
    try {
      const shown = { id: `shown:${host.targetDescription}`, name: "", connection: active?.connection ?? host.targetDescription.replace(/ \(daemon port \d+\)$/, "") };
      if (tryParse(shown.connection)?.kind !== "relay" && await this.deps.onTailnet(await this.endpoint(rt, active ?? shown))) rt.hint = reasonFor("tailscale_off");
    } catch { /* A description that is not a connection has no hint. */ }
  }

  // ---- what the panel asks for ----

  async state(): Promise<State> {
    const { directory, saved } = await this.refresh();
    const hosts = directory.hosts.map(host => this.view(host, saved.find(item => item.registrationId === host.registrationId) ?? null));
    const known = new Set(directory.hosts.map(host => host.registrationId));
    for (const orphan of saved.filter(item => !known.has(item.registrationId))) hosts.push({
      registrationId: orphan.registrationId, serverId: orphan.serverId, label: "Removed host", status: "disabled", headline: "No longer a connected host",
      reason: "Paseo no longer has this host. Its saved routes are still on this computer until you forget them.", since: null, routeSince: null,
      version: null, tooOld: false, mode: orphan.mode, busy: false, currentTarget: "", currentKnown: false,
      routes: orphan.routes.map(route => this.routeView(route, null, null)), events: orphan.events,
    });
    return { self: directory.self.label, tailscale: this.deps.tailscaleUp() ? "up" : "off", hosts };
  }
  private routeView(route: SavedRoute, activeId: string | null, check: Check | null, edited = false) {
    const parsed = tryParse(route.connection);
    return { id: route.id, name: route.name, kind: parsed?.kind ?? "direct" as const, target: parsed ? displayTarget(parsed.description) : "Unreadable connection", active: route.id === activeId, edited, check };
  }
  private view(host: HostSummary, saved: SavedHost | null): Host {
    const rt = this.rt(host.registrationId);
    const active = this.active(host, saved);
    const activeCheck = active ? rt.checks.get(active.id) ?? null : null;
    const tooOld = host.error?.code === "unsupported_capability" || (host.status !== "online" && activeCheck?.code === "too_old");
    const replaced = saved !== null && host.serverId !== null && saved.serverId !== host.serverId;
    const reason = replaced ? "This host is now a different Paseo. Forget its routes and add them again."
      : noAction.has(host.error?.code ?? "") && rt.hint ? rt.hint
      : saved?.routes.length && !active && host.status !== "disabled" ? `${host.status === "online" ? "" : `${rt.hint ?? "Paseo cannot reach this host."} `}The current connection is not one of the saved routes, so nothing is switched. Choose a route.`
      : host.status === "online" ? null
      : host.status === "disabled" ? "Turned off in Paseo's host list."
      : tooOld ? reasonFor("too_old", activeCheck?.version ?? null)
      : activeCheck && !activeCheck.ok ? activeCheck.reason
      : rt.hint ?? (host.status === "connecting" ? null : "Paseo cannot reach this host.");
    const by = active ? ` by ${active.name}` : "";
    const headline = tooOld ? "Too old to be a fleet host" : host.status === "online" ? `Online${by}` : host.status === "connecting" ? `Connecting${by}`
      : host.status === "disabled" ? "Turned off" : "Offline";
    return {
      registrationId: host.registrationId, serverId: host.serverId, label: host.label ?? "Host", status: host.status, headline, reason,
      since: rt.since ?? (host.status === "online" && host.lastOnlineAt ? Date.parse(host.lastOnlineAt) || null : null),
      routeSince: rt.routeSince, version: rt.version, tooOld, mode: saved?.mode ?? "manual", busy: rt.busy,
      currentTarget: displayTarget(host.targetDescription), currentKnown: active !== null,
      routes: (saved?.routes ?? []).map(route => this.routeView(route, active?.id ?? null, rt.checks.get(route.id) ?? null, rt.edited.has(route.id))),
      events: saved?.events ?? [],
    };
  }
  private async find(id: string): Promise<{ host: HostSummary; saved: SavedHost | null }> {
    const { directory, saved } = await this.refresh();
    const host = directory.hosts.find(item => item.registrationId === id);
    if (!host) throw new UserError("Paseo no longer has this host.");
    return { host, saved: saved.find(item => item.registrationId === id) ?? null };
  }
  private requireRoute(saved: SavedHost | null, routeId: string): SavedRoute {
    const route = saved?.routes.find(item => item.id === routeId);
    if (!route) throw new UserError("That route no longer exists.");
    return route;
  }

  saveRoute(input: { registrationId: string; routeId?: string; name: string; connection?: string }): Promise<State> {
    return this.serial(input.registrationId, async () => {
      const { host, saved } = await this.find(input.registrationId);
      if (!host.serverId) throw new UserError("This host has never connected, so its identity is unknown. Connect it once in Paseo first.");
      if (saved && saved.serverId !== host.serverId) throw new UserError("This host is now a different Paseo. Forget its routes first.");
      const existing = input.routeId ? this.requireRoute(saved, input.routeId) : null;
      const connection = input.connection?.trim() || existing?.connection;
      if (!connection) throw new UserError("Enter a connection.");
      const parsed = parseTarget(connection);
      if (parsed.serverId && parsed.serverId !== host.serverId) throw new UserError("That pairing link belongs to a different computer.");
      const others = (saved?.routes ?? []).filter(route => route.id !== existing?.id);
      if (others.some(route => tryParse(route.connection)?.description === parsed.description)) throw new UserError("This host already has a route to that address.");
      if (others.some(route => route.name.toLowerCase() === input.name.toLowerCase())) throw new UserError("This host already has a route with that name.");
      if (!existing && others.length >= MAX_ROUTES) throw new UserError(`A host can have ${MAX_ROUTES} routes.`);
      const id = existing?.id ?? randomUUID();
      const inUse = existing !== null && this.active(host, saved)?.id === existing.id;
      await this.store!.edit(hosts => {
        let entry = hosts.find(item => item.registrationId === host.registrationId);
        if (!entry) hosts.push(entry = { registrationId: host.registrationId, serverId: host.serverId!, mode: "manual", routes: [], events: [] });
        const route = entry.routes.find(item => item.id === id);
        if (inUse && parsed.description !== host.targetDescription) entry.mode = "manual";
        if (route) Object.assign(route, { name: input.name, connection });
        else entry.routes.push({ id, name: input.name, connection });
      });
      const rt = this.rt(host.registrationId);
      rt.endpoints.delete(id); rt.checks.delete(id); rt.passes.delete(id); rt.cooling.delete(id); rt.refused.delete(id);
      if (input.connection?.trim()) {
        const route = { id, name: input.name, connection };
        const result = await this.check(host, rt, route);
        // The address is the same but the key may not be, so Paseo must get the new one.
        if (inUse && existing!.connection !== connection && parsed.description === host.targetDescription) {
          rt.edited.add(id);
          if (result.ok && host.status !== "disabled" && !await this.apply("edit", host, rt, route, "Its connection was edited"))
            throw new UserError("The route was saved, but Paseo still uses the old connection. Press Connect again.");
        }
      }
    }).then(() => this.state());
  }
  removeRoute(input: { registrationId: string; routeId: string }): Promise<State> {
    return this.serial(input.registrationId, async () => {
      const { directory } = await this.refresh();
      const host = directory.hosts.find(item => item.registrationId === input.registrationId);
      await this.store!.edit(hosts => {
        const entry = hosts.find(item => item.registrationId === input.registrationId);
        if (!entry) return;
        if (!host || this.active(host, entry)?.id === input.routeId) entry.mode = "manual";
        entry.routes = entry.routes.filter(route => route.id !== input.routeId);
        if (entry.routes.length < 2) entry.mode = "manual";
      });
    }).then(() => this.state());
  }
  preferRoute(input: { registrationId: string; routeId: string }): Promise<State> {
    return this.serial(input.registrationId, async () => {
      await this.refresh();
      await this.store!.edit(hosts => {
        const entry = hosts.find(item => item.registrationId === input.registrationId);
        const route = this.requireRoute(entry ?? null, input.routeId);
        entry!.routes = [route, ...entry!.routes.filter(item => item.id !== route.id)];
      });
      this.rt(input.registrationId).passes.clear();
    }).then(() => this.state());
  }
  setMode(input: { registrationId: string; mode: Mode }): Promise<State> {
    return this.serial(input.registrationId, async () => {
      const { host, saved } = await this.find(input.registrationId);
      if (input.mode === "auto" && (saved?.routes.length ?? 0) < 2) throw new UserError("Automatic switching needs at least two routes.");
      if (input.mode === "auto" && !this.active(host, saved)) throw new UserError("Add the current connection as a route, or choose a route, first.");
      await this.store!.edit(hosts => {
        const entry = hosts.find(item => item.registrationId === input.registrationId);
        if (entry) entry.mode = input.mode;
      });
      const rt = this.rt(input.registrationId);
      rt.nextBackAt = 0; rt.nextCheckAt = 0; rt.backoff = 0; rt.refused.clear(); rt.cooling.clear();
      await this.note(input.registrationId, input.mode === "auto" ? "Automatic switching on." : "Automatic switching off.");
    }).then(() => this.state());
  }
  testRoutes(input: { registrationId: string }): Promise<State> {
    return this.serial(input.registrationId, async () => {
      const { host, saved } = await this.find(input.registrationId);
      if (!saved || !host.serverId || saved.serverId !== host.serverId) throw new UserError("There is no route to test.");
      const rt = this.rt(input.registrationId);
      await Promise.all(saved.routes.map(route => this.check(host, rt, route)));
    }).then(() => this.state());
  }
  useRoute(input: { registrationId: string; routeId: string }): Promise<State> {
    return this.serial(input.registrationId, async () => {
      const { host, saved } = await this.find(input.registrationId);
      const route = this.requireRoute(saved, input.routeId);
      if (!host.serverId || saved!.serverId !== host.serverId) throw new UserError("This host is now a different Paseo. Forget its routes first.");
      if (host.status === "disabled") throw new UserError("This host is turned off in Paseo.");
      const edited = this.rt(input.registrationId).edited.has(route.id);
      if (this.active(host, saved)?.id === route.id && host.status === "online" && !edited) throw new UserError("The host already uses this route.");
      const rt = this.rt(input.registrationId);
      const result = await this.check(host, rt, route);
      if (!result.ok) throw new UserError(`Not switched. ${result.reason}`);
      const switching = this.active(host, saved)?.id !== route.id;
      const setMode = (mode: Mode) => this.store!.edit(hosts => { const entry = hosts.find(item => item.registrationId === input.registrationId); if (entry) entry.mode = mode; });
      // A route chosen by hand stays until the user turns automatic switching on again. Saved first,
      // so a failed write cannot leave automatic switching to undo the choice.
      const off = switching && saved!.mode === "auto";
      if (off) await setMode("manual");
      if (!await this.apply(switching ? "hand" : edited ? "edit" : "again", host, rt, route, "Chosen by hand").catch(() => false)) {
        if (off) await setMode("auto");
        throw new UserError("Not switched. The host changed or came back meanwhile, or Paseo refused.");
      }
      if (off) await this.note(host.registrationId, "Automatic switching off.");
    }).then(() => this.state());
  }
  forget(input: { registrationId: string }): Promise<State> {
    return this.serial(input.registrationId, async () => {
      await this.refresh();
      await this.store!.edit(hosts => hosts.filter(item => item.registrationId !== input.registrationId));
      this.runtimes.delete(input.registrationId);
    }).then(() => this.state());
  }
}
