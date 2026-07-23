/**
 * test/helpers/freePort.mjs — port allocation + server spawn guards.
 *
 * Regression cover for the 2026-07-22 nightly outage: a pid-derived port landed
 * on 5000 (held permanently by macOS ControlCenter/AirPlay), server.js died with
 * EADDRINUSE, and the blocked `npm test` blocked the data push.
 *
 * Run with: node test/helpers/freePort.test.mjs
 */

import net from "node:net";
import { allocatePort, spawnServer, httpReady, stdoutReady } from "./freePort.mjs";

/**
 * A bare TCP listener that accepts connections and never answers.
 *
 * Tracks its sockets because net.Server has no closeAllConnections() (that is
 * http.Server only) and close() blocks until every live connection ends — and
 * httpReady's aborted probe leaves one behind every time.
 */
async function occupy(port, host = "0.0.0.0") {
  const sockets = new Set();
  const srv = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(port, host, res);
  });
  return async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => srv.close(r));
  };
}

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, got !== undefined ? `→ got ${JSON.stringify(got)}` : "");
  }
}

console.log("freePort: allocatePort");
{
  const ports = await Promise.all(Array.from({ length: 20 }, () => allocatePort()));
  assert("20 concurrent allocations all return numbers", ports.every((p) => Number.isInteger(p) && p > 0));
  assert("all are above the privileged range", ports.every((p) => p >= 1024), ports.filter((p) => p < 1024));
  assert("all 20 are distinct", new Set(ports).size === 20, new Set(ports).size);

  // The whole point: an OS-assigned port can never be 5000/7000 (macOS AirPlay).
  assert("never returns a macOS system-reserved port", !ports.some((p) => p === 5000 || p === 7000));

  const p = await allocatePort();
  const srv = net.createServer();
  await new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(p, "127.0.0.1", res);
  }).then(
    () => assert("an allocated port is actually bindable", true),
    (e) => assert("an allocated port is actually bindable", false, e.code)
  );
  await new Promise((r) => srv.close(r));
}

console.log("freePort: spawnServer — early-exit detection");
{
  // The defect this replaces: swsMarketDataGuard used to poll for the full 20s
  // with no early-exit check and no captured output, so a child that died
  // instantly reported a misleading "failed to boot".
  const t0 = Date.now();
  let err;
  try {
    await spawnServer({
      args: ["-e", "console.error('boom: synthetic crash'); process.exit(1)"],
      ready: httpReady({ path: "/healthz" }),
      timeoutMs: 20_000,
      attempts: 1,
    });
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - t0;
  assert("a child that exits immediately rejects", !!err);
  assert("rejects fast, not at the deadline", elapsed < 10_000, elapsed);
  assert("error names the exit info", /exited before boot/.test(err?.message || ""), err?.message);
  assert("error carries the child's captured output", /boom: synthetic crash/.test(err?.message || ""), err?.message);
}

console.log("freePort: httpReady — a half-open port cannot hang the poll loop");
{
  // A bare TCP listener accepts the connection but never answers HTTP. Without a
  // per-probe timeout, fetch() hangs forever and the caller's deadline is never
  // reached. macOS AirPlay on 5000 behaves like this.
  const port = await allocatePort();
  const release = await occupy(port, "127.0.0.1");
  const t0 = Date.now();
  const ready = httpReady({ path: "/healthz", probeTimeoutMs: 500 });
  const got = await ready(port);
  const elapsed = Date.now() - t0;
  await release();
  assert("probe against a half-open port resolves false", got === false, got);
  assert("probe gives up rather than hanging", elapsed < 3000, elapsed);
}

console.log("freePort: spawnServer — pinned busy port surfaces EADDRINUSE");
{
  const busy = await allocatePort();
  const release = await occupy(busy);
  let err;
  try {
    await spawnServer({
      port: busy,
      args: ["-e", "require('net').createServer().listen(process.env.PORT,'0.0.0.0')"],
      ready: httpReady({ path: "/healthz", probeTimeoutMs: 500 }),
      timeoutMs: 10_000,
      attempts: 1,
    });
  } catch (e) {
    err = e;
  }
  await release();
  assert("a pinned busy port rejects rather than hanging", !!err);
  assert("the EADDRINUSE reason is preserved", /EADDRINUSE/.test(err?.message || ""), err?.message);
}

console.log("freePort: spawnServer — boots on an unpinned port while 5000 is occupied");
{
  // 5000 is held by ControlCenter on macOS; on CI it may be free, so hold it
  // ourselves when we can. Either way the allocated port must be unaffected.
  let release = null;
  try {
    release = await occupy(5000);
  } catch {
    release = null; // already occupied — that is the condition we want anyway
  }

  const server = await spawnServer({
    args: [
      "-e",
      "const http=require('http');const p=process.env.PORT;" +
        "http.createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(p,()=>console.log('listening on http://localhost:'+p));",
    ],
    ready: stdoutReady((p) => `http://localhost:${p}`),
    timeoutMs: 15_000,
  });
  assert("booted despite 5000 being occupied", !!server.port);
  assert("did not pick a macOS-reserved port", server.port !== 5000 && server.port !== 7000, server.port);
  const res = await fetch(`http://localhost:${server.port}/`);
  assert("the spawned server actually answers", res.status === 200, res.status);
  await server.stop();
  assert("stop() reaps the child", server.proc.exitCode !== null || server.proc.killed);
  if (release) await release();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
