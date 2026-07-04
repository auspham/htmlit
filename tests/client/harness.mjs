/**
 * Test harness that boots the real htmlit daemon and opens a review session.
 *
 * The browser client under test is the exact file the daemon serves, so the
 * most faithful way to exercise it is to run the daemon itself, create a
 * session for a fixture artifact, and load the served page. This module hides
 * that setup behind {@link startReview} / {@link stopReview}.
 */

import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "..", "..", "skills", "htmlit");
const SERVER = join(SKILL_DIR, "htmlit_server.py");
const PYTHON = process.env.PYTHON ?? "python3";

async function waitFor(predicate, { tries = 100, interval = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await predicate();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

/**
 * Start the daemon and open a review for the given fixture file.
 *
 * @param {string} fixturePath absolute path to a standalone HTML artifact.
 * @returns {Promise<{base: string, key: string, url: string, stop: () => Promise<void>}>}
 */
export async function startReview(fixturePath) {
  const home = mkdtempSync(join(tmpdir(), "htmlit-test-"));
  // Open a copy so the daemon never touches the checked-in fixture.
  const artifact = join(home, basename(fixturePath));
  copyFileSync(fixturePath, artifact);

  const child = spawn(PYTHON, [SERVER, "--port", "0"], {
    env: { ...process.env, HTMLIT_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const registryPath = join(home, "server.json");
  const port = await waitFor(() => {
    try {
      return JSON.parse(readFileSync(registryPath, "utf8")).port;
    } catch {
      return null;
    }
  });
  if (!port) {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
    throw new Error(`htmlit daemon did not start.\n${stderr}`);
  }
  const base = `http://127.0.0.1:${port}`;

  const health = await waitFor(async () => {
    try {
      const res = await fetch(`${base}/health`);
      return res.ok;
    } catch {
      return null;
    }
  });
  if (!health) throw new Error("htmlit daemon health check never passed");

  const res = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  });
  if (!res.ok) throw new Error(`could not open session: ${res.status}`);
  const { key, url } = await res.json();

  const stop = async () => {
    try {
      await fetch(`${base}/shutdown`, { method: "POST", body: "{}" });
    } catch {
      // best effort; we kill the process below regardless
    }
    child.kill("SIGTERM");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { tries: 20 });
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  };

  return { base, key, url: `${base}${url}`, artifact, stop };
}
