import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockInstance } from "./instance-lock.ts";

it("excludes other processes and recovers after the owner is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psf-instance-"));
  const child = Bun.spawn([process.execPath, "-e", `
    import { lockInstance } from ${JSON.stringify(import.meta.dir + "/instance-lock.ts")};
    const release = lockInstance(process.env.TEST_STATE);
    console.log(release === null ? "busy" : "locked");
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, TEST_STATE: dir }, stdout: "pipe", stderr: "pipe" });
  let release: (() => void) | null = null;
  try {
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value).trim()).toBe("locked");
    expect(lockInstance(dir)).toBeNull();
    child.kill("SIGKILL");
    await child.exited;
    release = lockInstance(dir);
    expect(release).not.toBeNull();
    release?.();
    release = lockInstance(dir);
    expect(release).not.toBeNull();
  } finally {
    release?.();
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
