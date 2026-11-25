import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The first Paseo release that can be a connected host (PR #7370). */
export const FIRST_HOST_VERSION = "0.13.0";
export const MAX_ROUTES = 4;

const id = z.string().min(1).max(200);
export const failureCode = z.enum([
  "unreachable", "timeout", "tailscale_off", "dns", "refused", "ssh_denied", "ssh_host_key", "ssh_failed",
  "daemon_down", "auth", "wrong_host", "too_old", "relay", "unknown",
]);
export type FailureCode = z.infer<typeof failureCode>;

// Everything below is what clients receive. No schema here may carry a connection string.
export const checkSchema = z.object({
  at: z.number(),
  ok: z.boolean(),
  code: failureCode.nullable(),
  reason: z.string().nullable(),
  version: z.string().nullable(),
  ms: z.number(),
});
export type Check = z.infer<typeof checkSchema>;
export const routeSchema = z.object({
  id, name: z.string(), kind: z.enum(["ssh", "relay", "direct", "socket"]), target: z.string(),
  active: z.boolean(), edited: z.boolean(), check: checkSchema.nullable(),
});
export type Route = z.infer<typeof routeSchema>;
export const eventSchema = z.object({ at: z.number(), text: z.string() });
export type HostEvent = z.infer<typeof eventSchema>;
export const modeSchema = z.enum(["manual", "auto"]);
export type Mode = z.infer<typeof modeSchema>;
export const hostSchema = z.object({
  registrationId: id,
  serverId: z.string().nullable(),
  label: z.string(),
  status: z.enum(["online", "connecting", "offline", "error", "disabled"]),
  headline: z.string(),
  reason: z.string().nullable(),
  since: z.number().nullable(),
  routeSince: z.number().nullable(),
  version: z.string().nullable(),
  tooOld: z.boolean(),
  mode: modeSchema,
  busy: z.boolean(),
  currentTarget: z.string(),
  currentKnown: z.boolean(),
  routes: z.array(routeSchema),
  events: z.array(eventSchema),
});
export type Host = z.infer<typeof hostSchema>;
export const stateSchema = z.object({
  self: z.string(),
  tailscale: z.enum(["up", "off"]),
  hosts: z.array(hostSchema),
});
export type State = z.infer<typeof stateSchema>;

export const stateRpc = defineRpc({ name: "failover.state", input: z.object({}), output: stateSchema });
export const saveRouteRpc = defineRpc({
  name: "failover.route.save",
  input: z.object({ registrationId: id, routeId: id.optional(), name: z.string().trim().min(1).max(60), connection: z.string().max(16384).optional() }),
  output: stateSchema,
});
export const removeRouteRpc = defineRpc({ name: "failover.route.remove", input: z.object({ registrationId: id, routeId: id }), output: stateSchema });
export const preferRouteRpc = defineRpc({ name: "failover.route.prefer", input: z.object({ registrationId: id, routeId: id }), output: stateSchema });
export const testRoutesRpc = defineRpc({ name: "failover.route.test", input: z.object({ registrationId: id }), output: stateSchema });
export const useRouteRpc = defineRpc({ name: "failover.route.use", input: z.object({ registrationId: id, routeId: id }), output: stateSchema });
export const setModeRpc = defineRpc({ name: "failover.mode", input: z.object({ registrationId: id, mode: modeSchema }), output: stateSchema });
export const forgetRpc = defineRpc({ name: "failover.forget", input: z.object({ registrationId: id }), output: stateSchema });
