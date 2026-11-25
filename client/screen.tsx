import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, SidebarRow, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, Text, View } from "react-native";
import {
  MAX_ROUTES, forgetRpc, preferRouteRpc, removeRouteRpc, saveRouteRpc, setModeRpc, stateRpc, testRoutesRpc, useRouteRpc,
  type Host, type Route, type State,
} from "../shared/contract";

const queryKey = (hostId: string) => ["host-failover", hostId];
function useFailover(hostId: string, every: number | false) {
  const read = useRpc(stateRpc);
  return useQuery({ queryKey: queryKey(hostId), queryFn: () => read({}), refetchInterval: every, refetchIntervalInBackground: false, retry: false, networkMode: "always" });
}

/** Reading the state once also starts the engine after a daemon restart. */
export function FailoverItem({ currentScreen, openScreen, host, theme }: PluginSidebarItemProps) {
  const state = useFailover(host.id, 60_000);
  const down = state.data?.hosts.filter(item => item.routes.length > 0 && item.status !== "online" && item.status !== "disabled").length ?? 0;
  return <SidebarRow icon="Route" active={currentScreen?.screenId === "host-failover"} onPress={() => openScreen({ screenId: "host-failover" })}
    trailing={down ? <Text accessibilityLabel={`${down} not online`} style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{down}</Text> : undefined} />;
}

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} days`;
}
const message = (error: unknown) => error instanceof Error ? error.message : "That did not work.";
type Editing = { host: Host; route: Route | null; suggested: string };
type Action = (work: () => Promise<State>, done?: string) => Promise<boolean>;

export function FailoverScreen({ theme, layout, host }: PluginScreenProps) {
  const c = theme.colors;
  const toast = useToast();
  const client = useQueryClient();
  const [active, setActive] = useState(AppState.currentState !== "background");
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => { const sub = AppState.addEventListener("change", s => setActive(s === "active")); return () => sub.remove(); }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  useEffect(() => { setEditing(null); }, [host.id]);
  const state = useFailover(host.id, active ? 5000 : false);
  const rpc = {
    save: useRpc(saveRouteRpc), remove: useRpc(removeRouteRpc), prefer: useRpc(preferRouteRpc), test: useRpc(testRoutesRpc),
    use: useRpc(useRouteRpc), mode: useRpc(setModeRpc), forget: useRpc(forgetRpc),
  };
  const act: Action = async (work, done) => {
    setWorking(true);
    try { client.setQueryData(queryKey(host.id), await work()); if (done) toast.show(done, { variant: "success" }); return true; }
    catch (error) { toast.error(message(error)); void state.refetch(); return false; }
    finally { setWorking(false); }
  };
  const stale = state.isError || state.isPaused;
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 };
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 28, paddingBottom: 48, gap: 16, maxWidth: 880, width: "100%" }}>
    <View>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: layout.compact ? 22 : 26, fontWeight: "700" }}>Host Failover</Text>
      <Text style={{ ...muted, marginTop: 4 }}>Connected hosts of {host.label}{state.data?.tailscale === "off" ? " · Tailscale looks off here" : ""}</Text>
    </View>
    {stale && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{message(state.error)} What you see may be out of date.</Text>}
    {state.isPending && <Text style={muted}>Reading the hosts…</Text>}
    {state.data?.hosts.length === 0 && <Text style={muted}>Paseo has no connected hosts here yet. Add one with “paseo host add”, then give it a second route.</Text>}
    {state.data?.hosts.map(item => <HostCard key={item.registrationId} item={item} theme={theme} now={now} working={working} stale={stale} act={act} rpc={rpc}
      edit={(route, suggested = "") => setEditing({ host: item, route, suggested })} />)}
    {editing && <RouteForm key={`${editing.host.registrationId}:${editing.route?.id ?? "new"}`} editing={editing} theme={theme} working={working} close={() => setEditing(null)}
      save={(name, connection) => act(() => rpc.save({ registrationId: editing.host.registrationId, routeId: editing.route?.id, name, connection: connection || undefined }), "Route saved")} />}
  </ScrollView>;
}

function Button({ label, hint, onPress, disabled, theme, tone = "plain" }: { label: string; hint?: string; onPress(): void; disabled?: boolean; theme: PluginScreenProps["theme"]; tone?: "plain" | "primary" | "danger" }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={hint ?? label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, opacity: disabled ? 0.5 : 1, borderColor: tone === "danger" ? c.statusDanger : tone === "primary" ? c.accent : c.border, backgroundColor: tone === "primary" ? c.accent : c.surface1 }}>
    <Text style={{ fontSize: 14, color: tone === "primary" ? c.accentForeground : tone === "danger" ? c.statusDanger : c.foreground }}>{label}</Text>
  </Pressable>;
}

function HostCard({ item, theme, now, working, stale, act, rpc, edit }: {
  item: Host; theme: PluginScreenProps["theme"]; now: number; working: boolean; stale: boolean; act: Action; edit(route: Route | null, suggested?: string): void;
  rpc: {
    test(input: { registrationId: string }): Promise<State>; use(input: { registrationId: string; routeId: string }): Promise<State>;
    prefer(input: { registrationId: string; routeId: string }): Promise<State>; remove(input: { registrationId: string; routeId: string }): Promise<State>;
    mode(input: { registrationId: string; mode: "auto" | "manual" }): Promise<State>; forget(input: { registrationId: string }): Promise<State>;
  };
}) {
  const c = theme.colors;
  const [confirm, setConfirm] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const { registrationId } = item;
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 };
  const color = stale ? c.foregroundMuted : item.status === "online" ? c.statusSuccess : item.status === "connecting" ? c.statusWarning : item.status === "disabled" ? c.foregroundMuted : c.statusDanger;
  const gone = item.currentTarget === "";
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const };
  return <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: c.border, borderRadius: 14, backgroundColor: c.surface1 }}>
    <View style={{ gap: 4 }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{item.label}</Text>
      <Text style={{ color, fontSize: 15, fontWeight: "600" }}>{stale ? `Last known: ${item.headline}` : item.headline}</Text>
      {item.reason && <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>{item.reason}</Text>}
      <Text style={muted}>{[
        item.since ? `${item.status === "online" ? "Online" : "Since"} ${ago(item.since, now)}` : null,
        item.routeSince ? `this route ${ago(item.routeSince, now)}` : null,
        item.version ? `Paseo ${item.version}` : null, item.currentKnown || gone ? null : item.currentTarget,
      ].filter(Boolean).join(" · ")}</Text>
    </View>
    {item.routes.map((route, index) => <View key={route.id} style={{ gap: 8, paddingTop: 12, borderTopWidth: 1, borderColor: c.border }}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{index + 1}. {route.name}{route.active ? " · in use" : ""}</Text>
        <Text style={muted}>{route.target}</Text>
        {route.active && route.edited && <Text style={{ ...muted, color: c.statusWarning }}>Edited. Paseo still uses the old connection until it connects again.</Text>}
        {route.check && <Text style={{ ...muted, color: route.check.ok ? c.statusSuccess : c.statusDanger }}>{route.check.ok ? `Tested ${ago(route.check.at, now)}: works (${(route.check.ms / 1000).toFixed(1)} s)` : `Tested ${ago(route.check.at, now)}: ${route.check.reason}`}</Text>}
      </View>
      {!gone && <View style={row}>
        {(!route.active || route.edited || (item.status !== "online" && item.status !== "disabled")) && <Button theme={theme} label={route.active ? "Connect again" : "Use now"} hint={`${route.active ? "Connect again by" : "Use"} ${route.name} now for ${item.label}`} disabled={working || item.status === "disabled"} onPress={() => void act(() => rpc.use({ registrationId, routeId: route.id }), route.active ? `Connecting by ${route.name}` : `Switched to ${route.name}`)} />}
        {index > 0 && <Button theme={theme} label="Make first" hint={`Make ${route.name} the first route of ${item.label}`} disabled={working} onPress={() => void act(() => rpc.prefer({ registrationId, routeId: route.id }))} />}
        <Button theme={theme} label="Edit" hint={`Edit ${route.name} of ${item.label}`} disabled={working} onPress={() => edit(route)} />
        {confirm === route.id
          ? <><Button theme={theme} tone="danger" label="Remove route" hint={`Confirm removing ${route.name}`} disabled={working} onPress={() => { setConfirm(null); void act(() => rpc.remove({ registrationId, routeId: route.id })); }} /><Button theme={theme} label="Keep" onPress={() => setConfirm(null)} /></>
          : <Button theme={theme} label="Remove" hint={`Remove ${route.name} from ${item.label}`} disabled={working} onPress={() => setConfirm(route.id)} />}
      </View>}
    </View>)}
    {!gone && item.routes.length === 0 && <Text style={muted}>No saved routes. Add the connection this host uses now, then a second one.</Text>}
    {!gone && item.routes.length > 0 && <Text style={muted}>{item.mode === "auto" ? "Automatic: if the route in use fails its test, the next working route takes over. The first route returns when it has worked for a while." : item.routes.length > 1 ? "Automatic switching is off." : "Add a second route to allow automatic switching."}</Text>}
    <View style={row}>
      {!gone && item.routes.length > 1 && <Button theme={theme} tone={item.mode === "auto" ? "plain" : "primary"} label={item.mode === "auto" ? "Turn automatic off" : "Turn automatic on"} hint={`Turn automatic switching ${item.mode === "auto" ? "off" : "on"} for ${item.label}`} disabled={working} onPress={() => void act(() => rpc.mode({ registrationId, mode: item.mode === "auto" ? "manual" : "auto" }))} />}
      {!gone && item.routes.length > 0 && <Button theme={theme} label="Test routes" hint={`Test routes of ${item.label}`} disabled={working} onPress={() => void act(() => rpc.test({ registrationId }))} />}
      {!gone && item.routes.length < MAX_ROUTES && <Button theme={theme} label={item.currentKnown ? "Add route" : "Add current route"} hint={`Add route to ${item.label}`} disabled={working} onPress={() => edit(null, item.currentKnown ? "" : item.currentTarget)} />}
      {item.events.length > 0 && <Button theme={theme} label={history ? "Hide history" : "History"} hint={`${history ? "Hide" : "Show"} history of ${item.label}`} onPress={() => setHistory(!history)} />}
      {(gone || (item.reason?.includes("different Paseo") ?? false)) && (confirm === "forget"
        ? <><Button theme={theme} tone="danger" label="Forget routes" disabled={working} onPress={() => { setConfirm(null); void act(() => rpc.forget({ registrationId })); }} /><Button theme={theme} label="Keep" onPress={() => setConfirm(null)} /></>
        : <Button theme={theme} label="Forget…" hint={`Forget the routes of ${item.label}`} disabled={working} onPress={() => setConfirm("forget")} />)}
    </View>
    {history && item.events.map((event, index) => <Text key={index} style={muted}>{new Date(event.at).toLocaleString()} · {event.text}</Text>)}
  </View>;
}

function RouteForm({ editing, theme, working, close, save }: { editing: Editing; theme: PluginScreenProps["theme"]; working: boolean; close(): void; save(name: string, connection: string): Promise<boolean> }) {
  const c = theme.colors;
  const [name, setName] = useState(editing.route?.name ?? "");
  const [connection, setConnection] = useState("");
  const input = { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10, color: c.foreground, backgroundColor: c.surface0 };
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 };
  const ready = name.trim().length > 0 && (editing.route !== null || connection.trim().length > 0);
  return <Modal title={editing.route ? "Edit route" : `Add route to ${editing.host.label}`} open onOpenChange={open => { if (!open) close(); }}>
    <Modal.Content>
      <View style={{ gap: 6 }}>
        <Text style={{ color: c.foreground, fontSize: 14 }}>Name</Text>
        <TextInput accessibilityLabel="Route name" placeholder="Home SSH" placeholderTextColor={c.foregroundMuted} value={name} onChangeText={setName} maxLength={60} style={input} />
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ color: c.foreground, fontSize: 14 }}>Connection</Text>
        <TextInput accessibilityLabel="Connection" placeholder={editing.route ? "Leave empty to keep the saved one" : "ssh://user@host or a pairing link"} placeholderTextColor={c.foregroundMuted} value={connection} onChangeText={setConnection} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={input} />
        <Text style={muted}>{editing.suggested ? `Paseo now uses: ${editing.suggested}. Enter the same connection you gave Paseo. ` : ""}A pairing link is a full key to that computer. It is saved in a private file on this computer and never shown again.</Text>
      </View>
      <Button theme={theme} tone="primary" label={working ? "Testing…" : "Save and test"} disabled={working || !ready} onPress={() => { void save(name.trim(), connection.trim()).then(ok => { if (ok) close(); }); }} />
    </Modal.Content>
  </Modal>;
}
