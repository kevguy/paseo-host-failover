# Host Failover

Paseo saves one connection for each connected host. Host Failover keeps up to four, such as SSH and the relay, and moves the host to one that works.

A route must pass a full test (connection, identity and version) just before every switch. Automatic switching is off until you turn it on for a host. The first route returns after three passed tests in a row, and a route that soon drops again is left alone for longer each time.

The panel shows, on desktop and phone, whether each host is online, by which route and since when, its Paseo version, and why a route failed in plain words. A host that is too old says which version it needs.

Connections can be full keys to another computer. They are kept in one private file on the computer that runs the plugin, outside plugin settings, and no request returns them. Anyone who may manage plugins there can change routes.

The plugin does not add or remove hosts, replace identities, edit SSH configuration, control Tailscale or run commands on the other computer. While a host is offline it tests saved routes with growing pauses. While automatic is on, it opens a short TCP connection to the port in use about every 10 seconds, and tests better routes about every 15 seconds while a fallback is in use.

Needs Paseo 0.16.1 or later here and 0.13.0 or later on the hosts. After a Paseo restart, failover starts with the first app connection, agent turn or workspace change. Tested on macOS; not yet on Linux or Windows. Listing images use fictional hosts.
