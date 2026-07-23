/**
 * Hermetic port allocation + server spawning for tests that boot server.js.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Tests used to derive their port arithmetically from the pid, e.g.
 *   4111 + (process.pid % 1000)   → range 4111–5110
 *   4311 + (process.pid % 1000)   → range 4311–5310
 * Both ranges span port 5000, which on macOS is permanently bound by
 * ControlCenter (AirPlay Receiver). When the pid landed wrong, server.js died
 * with EADDRINUSE, the test threw, and — because the pre-push hook runs the
 * whole `npm test` chain — the nightly data push was blocked. That is what
 * happened on 2026-07-22.
 *
 * `listen(0)` ELIMINATES the problem rather than mitigating it: the OS assigns
 * from the ephemeral range (49152–65535 on macOS), which can never collide with
 * 5000 or 7000. Four tests in this repo already used that idiom inline
 * (marketVerdictRoute, staticCacheHeaders, oauthRedirectHost,
 * marketPublicCacheAuth); this factors it out and adds the pieces the
 * server-spawning tests need on top.
 *
 * The port is chosen by the TEST and passed to the child as PORT. It is never
 * chosen by the child: three callers detect boot by scanning the child's stdout
 * for the literal `http://localhost:${PORT}`, so the polled port and the
 * announced port must come from the same place or they silently diverge.
 */

import net from "node:net";
import { spawn } from "node:child_process";

/**
 * Ask the OS for a free TCP port, then release it.
 *
 * There is an unavoidable TOCTOU window between releasing the port here and the
 * child binding it. `spawnServer` closes that window by retrying on EADDRINUSE.
 */
export async function allocatePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Boot detector: poll an HTTP endpoint until `accept(status)` is true.
 *
 * `probeTimeoutMs` is load-bearing, not defensive garnish. A port can accept the
 * TCP connection and then never send an HTTP response — a bare TCP listener, a
 * wedged server, or macOS AirPlay on 5000. Without a per-request timeout that
 * `fetch` hangs forever, and because the deadline is only re-checked BETWEEN
 * probes, the caller's `timeoutMs` would never be enforced at all.
 */
export function httpReady({
  path = "/healthz",
  accept = (s) => s === 200,
  host = "localhost",
  probeTimeoutMs = 2000,
} = {}) {
  return async (port) => {
    try {
      const res = await fetch(`http://${host}:${port}${path}`, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      return accept(res.status);
    } catch {
      return false;
    }
  };
}

/**
 * Boot detector: scan captured child output for a needle.
 * `needle` may be a string or a (port) => string, so the announced port and the
 * expected port cannot drift apart.
 */
export function stdoutReady(needle) {
  return async (port, output) => {
    const want = typeof needle === "function" ? needle(port) : needle;
    return output().includes(want);
  };
}

const MAX_CHUNKS = 80; // ring-buffer bound, mirrors the prior cap in riskLabApi

/**
 * Spawn a server child on a hermetic port and wait for it to answer.
 *
 * Returns { proc, port, output(), stop() }.
 *
 * Beyond port safety this fixes two real defects that used to live in
 * swsMarketDataGuard: it DETECTS a child that exits early (instead of burning
 * the full timeout and reporting a misleading "failed to boot"), and it
 * actually READS the piped stdio (an unread pipe can fill and block a chatty
 * child, and it meant crash output was discarded).
 *
 * @param {object}   opts
 * @param {number}   [opts.port]     Pin a port (env override). Disables retry —
 *                                   a pinned port that is busy is a real error.
 * @param {Function} opts.ready      From httpReady()/stdoutReady().
 * @param {number}   [opts.attempts] Retries on EADDRINUSE when not pinned.
 */
export async function spawnServer({
  command = process.execPath,
  args = ["server.js"],
  cwd = process.cwd(),
  env = {},
  ready,
  port: pinnedPort,
  timeoutMs = process.env.CI ? 60_000 : 30_000,
  attempts = 3,
} = {}) {
  if (typeof ready !== "function") throw new TypeError("spawnServer: `ready` detector is required");

  const maxAttempts = pinnedPort ? 1 : Math.max(1, attempts);
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = pinnedPort ?? (await allocatePort());
    const chunks = [];
    const output = () => chunks.join("");

    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const collect = (chunk) => {
      chunks.push(String(chunk));
      if (chunks.length > MAX_CHUNKS) chunks.shift();
    };
    proc.stdout.on("data", collect);
    proc.stderr.on("data", collect);

    let exitInfo = null;
    const exited = new Promise((resolve) => {
      proc.once("exit", (code, signal) => {
        exitInfo = { code, signal };
        resolve(exitInfo);
      });
    });

    const stop = async () => {
      if (proc.killed || exitInfo) return;
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    };

    const deadline = Date.now() + timeoutMs;
    let booted = false;
    while (Date.now() < deadline) {
      if (await ready(port, output)) {
        booted = true;
        break;
      }
      if (exitInfo) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (booted) return { proc, port, output, stop };

    if (exitInfo) {
      const out = output().trim();
      // Retry only an unpinned port losing the TOCTOU race. A pinned port that
      // is occupied is a genuine configuration error and must surface.
      if (!pinnedPort && attempt < maxAttempts && /EADDRINUSE/.test(out)) {
        lastErr = new Error(`port ${port} raced (EADDRINUSE); retrying`);
        continue;
      }
      throw new Error(
        `server exited before boot on port ${port}: ${JSON.stringify(exitInfo)}\n${out}`
      );
    }

    await stop();
    throw new Error(
      `server failed to boot within ${Math.round(timeoutMs / 1000)}s on port ${port}\n${output().trim()}`
    );
  }

  throw lastErr ?? new Error("spawnServer: exhausted attempts");
}
