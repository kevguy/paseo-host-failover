import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP, connect } from "node:net";
import { networkInterfaces } from "node:os";
import type { Parsed } from "./target";

export function isTailnetAddress(address: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

/** A local Tailscale address means the tunnel is up. Nothing is run or asked. */
export function tailscaleUp(interfaces = networkInterfaces()): boolean {
  return Object.values(interfaces).some(list => list?.some(item => isTailnetAddress(item.address)));
}

export type Endpoint = { host: string; port: number; /** The server speaks first (SSH), so silence is a failure too. */ banner?: boolean };

/** Where a route's first TCP connection goes, or null when it cannot be known without logging in. */
export async function endpointOf(route: Parsed): Promise<Endpoint | null> {
  if (route.tcp) return route.tcp;
  if (!route.ssh) return null;
  const { host, port } = route.ssh;
  // Resolves the user's own ssh_config locally, exactly as Paseo's ssh will. No connection is made.
  const output = await new Promise<string>(resolve => {
    execFile("ssh", ["-G", ...(port ? ["-p", String(port)] : []), host], { timeout: 3000, maxBuffer: 256 * 1024 },
      (error, stdout) => resolve(error ? "" : stdout));
  });
  const value = (key: string) => new RegExp(`^${key} (.+)$`, "m").exec(output)?.[1]?.trim() ?? null;
  const via = (key: string) => { const found = value(key); return found !== null && found.toLowerCase() !== "none"; };
  if (via("proxyjump") || via("proxycommand")) return null;
  const hostname = value("hostname");
  const resolved = Number(value("port"));
  return hostname && resolved ? { host: hostname, port: resolved, banner: true } : null;
}

export async function onTailnet(endpoint: Endpoint | null): Promise<boolean> {
  if (!endpoint) return false;
  if (/\.ts\.net\.?$/i.test(endpoint.host)) return true;
  if (isIP(endpoint.host)) return isTailnetAddress(endpoint.host);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A resolver that never answers must not hold up a switch.
    const found = await Promise.race([lookup(endpoint.host), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
    return found !== null && isTailnetAddress(found.address);
  } catch { return false; } finally { clearTimeout(timer); }
}

export function reach(endpoint: Endpoint, timeoutMs = 4000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    // Own timer: socket.setTimeout does not cover a name lookup that never answers.
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once(endpoint.banner ? "data" : "connect", () => finish(true));
    socket.once("close", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
