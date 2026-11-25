import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Engine, realDeps, type HostsApi } from "./server/engine";
import { UserError } from "./server/target";
import { forgetRpc, preferRouteRpc, removeRouteRpc, saveRouteRpc, setModeRpc, stateRpc, testRoutesRpc, useRouteRpc } from "./shared/contract";

export default function contribute(server: PluginServerContext) {
  let engine: Engine | undefined;
  // Paseo gives a plugin its API only inside handlers and hooks, so the first one starts the engine.
  const attach = (paseo: { hosts: HostsApi }): Engine => {
    if (!engine) { engine = new Engine(realDeps(paseo.hosts)); engine.start(); }
    return engine;
  };
  // An unexpected error could quote what it failed on, so only our own sentences leave the process.
  const safe = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) {
      throw new Error(error instanceof UserError || (error instanceof Error && /^(The (saved )?routes |Paseo did not answer)/.test(error.message)) ? error.message : "Host Failover could not finish that.");
    }
  };
  server.handle(stateRpc, (_input, { paseo }) => safe(() => attach(paseo).state()));
  server.handle(saveRouteRpc, (input, { paseo }) => safe(() => attach(paseo).saveRoute(input)));
  server.handle(removeRouteRpc, (input, { paseo }) => safe(() => attach(paseo).removeRoute(input)));
  server.handle(preferRouteRpc, (input, { paseo }) => safe(() => attach(paseo).preferRoute(input)));
  server.handle(testRoutesRpc, (input, { paseo }) => safe(() => attach(paseo).testRoutes(input)));
  server.handle(useRouteRpc, (input, { paseo }) => safe(() => attach(paseo).useRoute(input)));
  server.handle(setModeRpc, (input, { paseo }) => safe(() => attach(paseo).setMode(input)));
  server.handle(forgetRpc, (input, { paseo }) => safe(() => attach(paseo).forget(input)));
  const wake = async (_payload: unknown, { paseo }: { paseo: { hosts: HostsApi } }) => { attach(paseo); };
  const hooks = [
    server.addHook("agent.turn.after", wake), server.addHook("agent.create.after", wake),
    server.addHook("workspace.create.after", wake), server.addHook("agent.close.after", wake),
  ];
  return () => { hooks.forEach(remove => remove()); engine?.stop(); };
}
