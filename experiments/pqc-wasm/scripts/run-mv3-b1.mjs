#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";

import {
  loadGoldenVectors,
  serializeGoldenVectorsModule,
} from "../src/golden-vectors-from-rust.mjs";

function parseArgs(argv) {
  const args = {
    variant: "baseline",
    iterations: 20,
    warmup: 2,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--variant") args.variant = argv[++i];
    else if (arg === "--iterations") args.iterations = Number(argv[++i]);
    else if (arg === "--warmup") args.warmup = Number(argv[++i]);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--dist") args.dist = argv[++i];
    else if (arg === "--chrome") args.chrome = argv[++i];
    else if (arg === "--headful") args.headful = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function findBundledChromeForTesting(repoRoot) {
  const chromeRoot = join(repoRoot, ".context/browsers/chrome");
  if (!existsSync(chromeRoot)) {
    return null;
  }

  for (const versionDir of readdirSync(chromeRoot).sort().reverse()) {
    const platformDir = join(chromeRoot, versionDir);
    for (const candidatePlatform of ["chrome-mac-arm64", "chrome-mac-x64", "chrome-linux64"]) {
      const candidate =
        candidatePlatform === "chrome-linux64"
          ? join(platformDir, candidatePlatform, "chrome")
          : join(
              platformDir,
              candidatePlatform,
              "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            );
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function findSystemAutomationChrome() {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "linux"
        ? [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome-for-testing",
          ]
        : [];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });
}

async function fetchJson(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError ?? new Error(`timed out fetching ${url}`);
}

async function findServiceWorkerTarget(port, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 5000);
    const target = targets.find(
      (candidate) =>
        candidate.type === "service_worker" &&
        candidate.url.startsWith("chrome-extension://") &&
        candidate.url.endsWith("/background.mjs"),
    );
    if (target) {
      return target;
    }
    await delay(250);
  }
  throw new Error("timed out waiting for MV3 service worker target");
}

async function findExtensionId(profileDir, extensionDir, timeoutMs = 30000) {
  const prefsPath = join(profileDir, "Default", "Secure Preferences");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
      const settings = prefs.extensions?.settings ?? {};
      for (const [id, setting] of Object.entries(settings)) {
        if (
          setting.path === extensionDir ||
          setting.manifest?.name === "Qbit PQC B1 WASM Harness"
        ) {
          return id;
        }
      }
    } catch {
      // Chrome may not have flushed Secure Preferences yet.
    }
    await delay(250);
  }
  throw new Error("timed out waiting for unpacked extension ID in Chrome profile");
}

function cdpConnect(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") {
    throw new Error("this Node version does not expose global WebSocket");
  }

  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`${entry.method} failed: ${message.error.message}: ${message.error.data ?? ""}`));
    } else {
      entry.resolve(message.result);
    }
  });

  const open = new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", rejectOpen, { once: true });
  });

  return {
    async send(method, params = {}) {
      await open;
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolveSend, rejectSend) => {
        pending.set(id, { method, resolve: resolveSend, reject: rejectSend });
      });
    },
    close() {
      ws.close();
    },
  };
}

async function waitForHarness(cdp) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "globalThis.__B1_READY__ === true",
      returnByValue: true,
    });
    if (result.result?.value === true) {
      return;
    }
    await delay(250);
  }
  throw new Error("timed out waiting for __B1_HARNESS__ readiness");
}

function prepareExtension({ repoRoot, variant, distRoot }) {
  const variantDir = join(distRoot, variant);
  const scratchRoot = join(repoRoot, ".context/pqc-wasm-spike");
  const extensionDir = join(scratchRoot, `mv3-extension-${variant}`);

  rmSync(extensionDir, { recursive: true, force: true });
  mkdirSync(extensionDir, { recursive: true });

  copyFileSync(join(variantDir, "pqc.mjs"), join(extensionDir, "pqc.mjs"));
  const wasmPath = join(variantDir, "pqc.wasm");
  if (existsSync(wasmPath)) {
    copyFileSync(wasmPath, join(extensionDir, "pqc.wasm"));
  }
  copyFileSync(join(repoRoot, "experiments/pqc-wasm/src/pqc-wrapper.mjs"), join(extensionDir, "pqc-wrapper.mjs"));
  copyFileSync(join(repoRoot, "experiments/pqc-wasm/src/pqc-suite.mjs"), join(extensionDir, "pqc-suite.mjs"));
  copyFileSync(join(repoRoot, "experiments/pqc-wasm/mv3/background.mjs"), join(extensionDir, "background.mjs"));
  writeFileSync(
    join(extensionDir, "runner.html"),
    '<!doctype html><meta charset="utf-8"><title>B1 MV3 Runner</title><script type="module" src="./runner.mjs"></script>\n',
  );
  writeFileSync(
    join(extensionDir, "runner.mjs"),
    'chrome.runtime.sendMessage({ type: "b1-ping" }, () => { document.body.textContent = "ready"; });\n',
  );

  const vectors = loadGoldenVectors({ repoRoot });
  writeFileSync(join(extensionDir, "golden-vectors-data.mjs"), serializeGoldenVectorsModule(vectors));
  writeFileSync(
    join(extensionDir, "manifest.json"),
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: "Qbit PQC B1 WASM Harness",
        version: "0.0.1",
        background: {
          service_worker: "background.mjs",
          type: "module",
        },
        content_security_policy: {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        },
      },
      null,
      2,
    )}\n`,
  );

  return extensionDir;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const args = parseArgs(process.argv.slice(2));
const distRoot = resolve(repoRoot, args.dist ?? ".context/pqc-wasm-spike/dist");
const extensionDir = prepareExtension({ repoRoot, variant: args.variant, distRoot });
const chromePath =
  args.chrome ??
  process.env.CHROME_PATH ??
  findBundledChromeForTesting(repoRoot) ??
  findSystemAutomationChrome();
if (!chromePath) {
  throw new Error(
    "Chrome for Testing or Chromium is required. Install one with `pnpm dlx @puppeteer/browsers install chrome@stable --path .context/browsers`, pass `--chrome`, or set CHROME_PATH.",
  );
}
const profileDir = join(repoRoot, ".context/pqc-wasm-spike", `chrome-profile-${args.variant}`);
const outPath = resolve(repoRoot, args.out ?? `.context/pqc-wasm-spike/mv3-${args.variant}.json`);
const port = await freePort();

rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });

const chrome = spawn(chromePath, [
  ...(args.headful ? [] : ["--headless=new"]),
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  "about:blank",
]);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

let cdp;
try {
  await fetchJson(`http://127.0.0.1:${port}/json/version`);
  await findExtensionId(profileDir, extensionDir);
  const target = await findServiceWorkerTarget(port);
  cdp = cdpConnect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await delay(250);
  await waitForHarness(cdp);

  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: `globalThis.__B1_HARNESS__.run(${JSON.stringify({
      variant: args.variant,
      iterations: args.iterations,
      warmup: args.warmup,
    })})`,
    awaitPromise: true,
    returnByValue: true,
  });

  if (evaluated.exceptionDetails) {
    throw new Error(JSON.stringify(evaluated.exceptionDetails, null, 2));
  }

  const result = evaluated.result.value;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  const summary = result.benchmarks.map((bench) => ({
    operation: bench.operation,
    medianMs: Number(bench.medianMs.toFixed(2)),
    p95Ms: Number(bench.p95Ms.toFixed(2)),
  }));
  console.log(JSON.stringify({ outPath, env: result.env, variant: result.variant, summary }, null, 2));
} catch (error) {
  error.message = `${error.message}\nChrome stderr:\n${stderr}`;
  throw error;
} finally {
  if (cdp) cdp.close();
  chrome.kill("SIGTERM");
}
