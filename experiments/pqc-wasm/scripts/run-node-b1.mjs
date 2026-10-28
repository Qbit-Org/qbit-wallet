#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadGoldenVectors } from "../src/golden-vectors-from-rust.mjs";
import { createPqcClient } from "../src/pqc-wrapper.mjs";
import { runB1Suite } from "../src/pqc-suite.mjs";

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
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const args = parseArgs(process.argv.slice(2));
const distRoot = resolve(repoRoot, args.dist ?? ".context/pqc-wasm-spike/dist");
const variantDir = join(distRoot, args.variant);
const modulePath = join(variantDir, "pqc.mjs");
const outPath = resolve(repoRoot, args.out ?? `.context/pqc-wasm-spike/node-${args.variant}.json`);

const { default: createPqcModule } = await import(pathToFileURL(modulePath).href);
const vectors = loadGoldenVectors({ repoRoot });

const result = await runB1Suite({
  env: "node",
  variant: args.variant,
  iterations: args.iterations,
  warmup: args.warmup,
  vectors,
  createClient: () =>
    createPqcClient({
      createModule: createPqcModule,
      moduleOptions: {
        locateFile: (path) => join(variantDir, path),
      },
    }),
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

const summary = result.benchmarks.map((bench) => ({
  operation: bench.operation,
  medianMs: Number(bench.medianMs.toFixed(2)),
  p95Ms: Number(bench.p95Ms.toFixed(2)),
}));
console.log(JSON.stringify({ outPath, env: result.env, variant: result.variant, summary }, null, 2));
