import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vite-plus/test";

test("a sales call notes one waiting-list email address and sends nothing", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("./waiting-list-regression.ts", import.meta.url))],
    { timeout: 10_000 },
  );
  assert.match(stdout, /PASS: waiting list/);
}, 15_000);
