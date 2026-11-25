import { parseHostTarget } from "@getpaseo/client/node";

export type Parsed = {
  kind: "ssh" | "relay" | "direct" | "socket";
  /** Paseo's own credential-free description; equals HostSummary.targetDescription. */
  description: string;
  serverId: string | null;
  ssh: { host: string; port: number | null } | null;
  tcp: { host: string; port: number } | null;
};

export class UserError extends Error {}

export function parseTarget(connection: string): Parsed {
  let target: ReturnType<typeof parseHostTarget>;
  try { target = parseHostTarget(connection); } catch {
    throw new UserError("That is not a connection Paseo accepts. Use ssh://, a pairing link, relay://, tcp://, ws(s):// or host:port.");
  }
  if (target.kind === "ssh") {
    return { kind: "ssh", description: target.description, serverId: null, ssh: { host: target.ssh.host, port: target.ssh.sshPort ?? null }, tcp: null };
  }
  if (target.offer) return { kind: "relay", description: target.description, serverId: target.offer.serverId, ssh: null, tcp: null };
  if (target.socketPath) return { kind: "socket", description: target.description, serverId: null, ssh: null, tcp: null };
  const url = new URL(target.url);
  const port = Number(url.port) || (url.protocol === "wss:" ? 443 : 80);
  return { kind: "direct", description: target.description, serverId: null, ssh: null, tcp: { host: url.hostname.replace(/^\[|\]$/g, ""), port } };
}

/** What the panel shows: no user name, path, server ID or credential. */
export function displayTarget(description: string): string {
  if (description.startsWith("relay://")) return `Paseo relay (${description.slice(8).split("/")[0]})`;
  if (description.startsWith("ssh://")) return `SSH to ${description.slice(6).replace(/ \(daemon port 6767\)$/, "")}`;
  if (/^(unix|pipe):/.test(description)) return "Local socket";
  return `Direct to ${description.replace(/^[a-z]+:\/\//, "")}`;
}

export function tryParse(connection: string): Parsed | null {
  try { return parseTarget(connection); } catch { return null; }
}
