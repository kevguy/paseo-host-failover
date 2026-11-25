import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostDirectory, HostSummary } from "@getpaseo/protocol/hosts";
import type { Check, FailureCode } from "../shared/contract";
import { reasonFor } from "../server/check";
import { Engine, type Deps } from "../server/engine";
import { Store } from "../server/store";
import { parseTarget } from "../server/target";

export const SSH = "ssh://alex@build-box.example";
export const KEY = "PLANTEDKEYPLANTEDKEYPLANTEDKEYPLANTEDKEY12=";
export const RELAY = `relay://relay.example:443/srv_build?key=${encodeURIComponent(KEY)}&ssl=true`;

export function directory(): string {
  const root = join(import.meta.dirname, "..", ".validation");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "t-"));
}

/** A fake Paseo with one host whose routes can be up or down. */
export class World {
  time = 1_000_000;
  down = new Map<string, FailureCode>();
  unreachable = new Set<string>();
  connection = SSH;
  updates: string[] = [];
  connections: string[] = [];
  checks: string[] = [];
  summary: HostSummary;
  dir = directory();
  store = new Store(this.dir);
  engine: Engine;
  /** When false, a lost link is not noticed by Paseo, as in the minute before its heartbeat fails. */
  noticed = true;
  tailscale = true;
  /** Routes that pass a test but that Paseo cannot use. */
  unusable = new Set<string>();
  /** Paseo stops trying for good, as after a refused login. */
  stuck = false;
  refuseUpdate = false;
  listFails = false;
  /** Runs inside every route test. */
  during: (() => unknown) | null = null;
  constructor(over: Partial<HostSummary> = {}) {
    this.summary = {
      registrationId: "reg-1", serverId: "srv_build", label: "Build box", source: { id: "cli", key: "x" }, metadata: {}, enabled: true,
      status: "online", targetDescription: parseTarget(SSH).description, lastOnlineAt: null, nextRetryAt: null, error: null, ...over,
    };
    const deps: Deps = {
      hosts: {
        list: async (): Promise<HostDirectory> => { if (this.listFails) throw new Error("no answer"); this.settle(); return { self: { serverId: "srv_self", label: "Laptop" }, hosts: [structuredClone(this.summary)] }; },
        update: async (_id, patch) => {
          if (this.refuseUpdate) throw new Error(patch.connection);
          this.connection = patch.connection; this.updates.push(patch.connection === SSH ? "ssh" : "relay");
          this.stuck = false; this.connections.push(patch.connection);
          Object.assign(this.summary, { targetDescription: parseTarget(patch.connection).description, status: "connecting", error: null });
          return structuredClone(this.summary);
        },
      },
      store: () => this.store,
      check: async (target): Promise<Check> => {
        this.checks.push(target.parsed.kind);
        await this.during?.();
        const code = this.down.get(target.parsed.kind) ?? null;
        return { at: this.time, ok: code === null, code, reason: code ? reasonFor(code) : null, version: code ? null : "0.17.4", ms: 5 };
      },
      reach: async endpoint => !this.unreachable.has(endpoint.host),
      endpointOf: async parsed => (parsed.ssh ? { host: "build-box", port: 22 } : null),
      onTailnet: async endpoint => endpoint !== null,
      tailscaleUp: () => this.tailscale,
      now: () => this.time,
    };
    this.engine = new Engine(deps);
  }
  settle() {
    if (!this.noticed || this.summary.status === "error" || this.summary.status === "disabled" || this.summary.error?.code === "unsupported_capability") return;
    const code = this.down.get(parseTarget(this.connection).kind);
    if (this.stuck) { this.summary.status = "offline"; return; }
    this.summary.status = code || this.unusable.has(parseTarget(this.connection).kind) ? "offline" : "online";
  }
  async tick(seconds = 5) { this.time += seconds * 1000; await this.engine.tick(); await this.engine.lastWork; }
  async run(seconds: number) { for (let passed = 0; passed < seconds; passed += 5) await this.tick(); }
  async setUp(mode: "auto" | "manual" = "auto") {
    await this.engine.saveRoute({ registrationId: "reg-1", name: "Home SSH", connection: SSH });
    await this.engine.saveRoute({ registrationId: "reg-1", name: "Relay", connection: RELAY });
    if (mode === "auto") await this.engine.setMode({ registrationId: "reg-1", mode });
    await this.run(10);
  }
  async host() { return (await this.engine.state()).hosts[0]!; }
}
