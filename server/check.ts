import { createHostClient, createSshTunnel, parseHostTarget, type SshTunnel } from "@getpaseo/client/node";
import { FIRST_HOST_VERSION, type Check, type FailureCode } from "../shared/contract";
import { endpointOf, onTailnet, tailscaleUp } from "./network";
import type { Parsed } from "./target";

const sentences: Record<FailureCode, string> = {
  unreachable: "The host cannot be reached by this route.",
  timeout: "No answer in time.",
  tailscale_off: "Tailscale looks off on this computer, and this route needs it.",
  dns: "The host name cannot be found.",
  refused: "The computer answered but refused the connection.",
  ssh_denied: "SSH refused the login. The key may be missing or locked.",
  ssh_host_key: "SSH does not trust this computer's host key. Connect once with ssh in a terminal.",
  ssh_failed: "SSH could not connect.",
  daemon_down: "SSH works, but Paseo is not running on that computer.",
  auth: "Paseo on that computer refused the password or pairing.",
  wrong_host: "This route reaches a different computer's Paseo.",
  too_old: `This host's Paseo is too old to be a fleet host. It needs ${FIRST_HOST_VERSION} or later.`,
  relay: "The relay answered, but the host is not connected to it.",
  unknown: "The route failed for a reason Paseo did not give.",
};
export function reasonFor(code: FailureCode, version?: string | null): string {
  if (code === "too_old" && version) return `This host's Paseo (${version}) is too old to be a fleet host. It needs ${FIRST_HOST_VERSION} or later.`;
  return sentences[code];
}

/** What ssh itself says. Its stderr also holds banners and warnings, so only its own phrases count. */
export function classifySsh(stderr: string): FailureCode | null {
  const text = stderr.toLowerCase();
  if (/host key verification failed|remote host identification has changed/.test(text)) return "ssh_host_key";
  if (/permission denied \(|too many authentication failures/.test(text)) return "ssh_denied";
  if (/administratively prohibited/.test(text)) return "ssh_failed";
  if (/channel \d+: open failed: connect failed|stdio forwarding failed/.test(text)) return "daemon_down";
  if (/could not resolve hostname/.test(text)) return "dns";
  const connect = /connect to (?:host|address) .*?: (.*)/.exec(text)?.[1] ?? "";
  return connect ? classify(connect) : null;
}
/** Raw errors can quote the connection, so they only choose a code and are then dropped. */
export function classify(message: string): FailureCode {
  const text = message.toLowerCase();
  if (/enotfound|eai_again|name or service not known/.test(text)) return "dns";
  if (/timed? ?out|etimedout/.test(text)) return "timeout";
  if (/connection refused|econnrefused/.test(text)) return "refused";
  if (/no route to host|unreachable|ehostunreach|enetunreach|econnreset|enetdown/.test(text)) return "unreachable";
  return "unknown";
}

const silent = new Set<FailureCode>(["unreachable", "timeout", "dns", "ssh_failed", "unknown"]);

export type Target = { connection: string; parsed: Parsed; serverId: string; clientId: string };

/**
 * Connects through a route the way Paseo would, reads the daemon's identity and version, and leaves.
 * The live link is not used and no command runs on the host.
 */
export async function checkRoute(target: Target, timeoutMs = 8000): Promise<Check> {
  const at = Date.now();
  const done = (code: FailureCode | null, version: string | null = null): Check =>
    ({ at, ok: code === null, code, reason: code ? reasonFor(code, version) : null, version, ms: Date.now() - at });
  let raw = "";
  let code: FailureCode | null = null;
  let version: string | null = null;
  let tunnel: SshTunnel | null = null;
  try {
    // The client hides ssh's own error, so a test opens the tunnel itself, the way the client would.
    const host = parseHostTarget(target.connection);
    let connection = target.connection;
    if (host.kind === "ssh") {
      tunnel = await createSshTunnel(host.ssh);
      connection = `tcp://${tunnel.endpoint}${host.password ? `?password=${encodeURIComponent(host.password)}` : ""}`;
    }
    const client = createHostClient(connection, {
      clientId: target.clientId, connectTimeoutMs: timeoutMs, reconnect: { enabled: false },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const off = client.subscribeConnectionStatus(state => { if (state.status === "disconnected") raw += ` ${state.failureCode ?? ""} ${state.reason ?? ""}`; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs + 500); }),
      ]);
      const info = client.getLastServerInfoMessage();
      version = typeof info?.version === "string" ? info.version.slice(0, 40) : null;
      if (!info) code = "unknown";
      else if (info.serverId !== target.serverId) { code = "wrong_host"; version = null; }
      else if (info.features?.connectedHosts !== true || info.features?.hostMultiplexing !== true) code = "too_old";
    } catch (error) {
      raw += ` ${error instanceof Error ? error.message : ""} ${client.lastError ?? ""}`;
      code = client.authFailureReason !== null ? "auth" : (tunnel && classifySsh(tunnel.failureDetail() ?? "")) || classify(raw);
      if (code === "unknown" && target.parsed.kind === "ssh") code = "ssh_failed";
      if (code === "unknown" && target.parsed.kind === "relay") code = "relay";
    } finally {
      clearTimeout(timer);
      off();
      await client.close().catch(() => {});
    }
  } catch { code = "unknown"; } finally { tunnel?.close(); }
  // Only failures in which the host never answered can be Tailscale's doing.
  if (code && silent.has(code) && target.parsed.kind !== "relay" && !tailscaleUp()
    && await onTailnet(await endpointOf(target.parsed))) code = "tailscale_off";
  return done(code, version);
}
