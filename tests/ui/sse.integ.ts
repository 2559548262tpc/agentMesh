import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startUiServer } from "../../src/ui/server.js";

describe("GET /api/events (SSE)", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    // Temp dirs left in place for post-mortem; the OS cleans tmpdir.
  });

  it("pushes a change event when watched data files change", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "agentmesh-sse-"));
    tempDirs.push(homeDir);
    mkdirSync(join(homeDir, "tasks"), { recursive: true });
    const handle = await startUiServer({ homeDir });
    const response = await fetch(`${handle.url}/api/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Read the stream: first wait for the connected comment (guarantees the
    // server-side fs.watchers are registered), then for the change event.
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readPromise = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        if (received.includes("event: change")) return;
      }
    })();
    await Promise.race([
      (async () => {
        while (!received.includes(": connected")) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no connected")), 3_000)),
    ]);

    // Trigger: append to the watched tasks dir (mirrors registry.jsonl append).
    writeFileSync(join(homeDir, "tasks", "registry.jsonl"), `{"taskId":"t1"}\n`, "utf-8");
    await Promise.race([
      readPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`no change event; got: ${received}`)), 5_000),
      ),
    ]);

    await reader.cancel().catch(() => undefined);
    await handle.close();
  });
});
