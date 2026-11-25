import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_ROUTES, eventSchema, modeSchema } from "../shared/contract";

const savedRoute = z.object({ id: z.string().min(1), name: z.string().min(1), connection: z.string().min(1) });
const savedHost = z.object({
  registrationId: z.string().min(1), serverId: z.string().min(1), mode: modeSchema,
  routes: z.array(savedRoute).max(MAX_ROUTES), events: z.array(eventSchema).max(40),
});
const fileSchema = z.object({ version: z.literal(1), hosts: z.array(savedHost) });
export type SavedRoute = z.infer<typeof savedRoute>;
export type SavedHost = z.infer<typeof savedHost>;

/**
 * Connection strings are keys to the host, so they live in one private file and nowhere else.
 * Every read takes the file as it is, and every change is one queued read, change and replace.
 */
export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}

  static for(serverId: string): Store {
    const root = process.env.PASEO_HOST_FAILOVER_DIR ?? join(homedir(), ".paseo-host-failover");
    return new Store(join(root, encodeURIComponent(serverId).replace(/^\.+$/, "_")));
  }
  private get path() { return join(this.directory, "routes.json"); }

  async load(): Promise<SavedHost[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
      for (const [path, mode] of [[this.directory, 0o700], [this.path, 0o600]] as const) if ((await stat(path)).mode & 0o077) await chmod(path, mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("The saved routes cannot be read.");
    }
    // Never replace a file this version cannot read: it holds the only copy of the links.
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error("The saved routes file is damaged. It was left unchanged."); }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) throw new Error("The saved routes file is damaged or from a newer version. It was left unchanged.");
    return parsed.data.hosts;
  }

  private async write(hosts: SavedHost[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    // A crash during a save can leave one of these, and it holds links.
    for (const name of await readdir(this.directory)) {
      const left = join(this.directory, name);
      // Only old ones, so a save in progress elsewhere is not disturbed.
      if (name.startsWith(".routes-") && Date.now() - (await stat(left).catch(() => null))?.mtimeMs! > 60_000) await rm(left, { force: true });
    }
    const pending = join(this.directory, `.routes-${randomUUID()}`);
    try {
      const file = await open(pending, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify({ version: 1, hosts }, null, 1)}\n`); await file.sync(); } finally { await file.close(); }
      await rename(pending, this.path);
    } finally { await rm(pending, { force: true }); }
  }

  edit(change: (hosts: SavedHost[]) => SavedHost[] | void): Promise<void> {
    const next = this.queue.then(async () => {
      const hosts = await this.load();
      const changed = change(hosts) ?? hosts;
      try { await this.write(changed); } catch { throw new Error("The routes could not be saved."); }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
