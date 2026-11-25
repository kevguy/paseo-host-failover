import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FailoverItem, FailoverScreen } from "./client/screen";
export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "host-failover", title: "Host Failover", Component: FailoverScreen });
  client.addSidebarHeaderItem({ id: "host-failover", title: "Host Failover", Component: FailoverItem });
  return () => {};
}
