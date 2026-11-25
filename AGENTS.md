# Host Failover

Portable Paseo plug-in. No private host names, addresses, paths, credentials or company data in source, tests, images or package.

Connection strings are keys. They enter only through `failover.route.save`, live only in the 0600 routes file, and leave only to `hosts.update` and `createHostClient`. Never return, log or put one in an error: raw connection errors choose a code and are dropped (`server/check.ts`).

`Engine.apply` is the only place a connection changes. It must follow a passed full test of that route, and re-read the host first. Never add or remove hosts, send `replaceIdentity`, write SSH configuration, control Tailscale or run anything on a host.

Tests use `.validation/`. No OS screenshots or input. No broad process kills. No commits or pushes by subagents.
