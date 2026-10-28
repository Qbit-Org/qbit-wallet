#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectedSlhDsaGoldenFiles,
  fixturePaths,
  resolveUpstreamPath,
} from "../src/slh-dsa-golden-fixture.mjs";

function scriptRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function parseArgs(argv) {
  const args = { repoRoot: scriptRepoRoot(), upstream: undefined };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo-root") {
      if (!argv[i + 1]) {
        throw new Error("--repo-root requires a value");
      }
      args.repoRoot = resolve(argv[++i]);
    } else if (arg === "--upstream") {
      if (!argv[i + 1]) {
        throw new Error("--upstream requires a value");
      }
      args.upstream = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const upstreamPath = resolveUpstreamPath(args.repoRoot, args.upstream);
  const { fixtureText, fixtureHash, hashText } = expectedSlhDsaGoldenFiles(upstreamPath);
  const { fixturePath, hashPath } = fixturePaths(args.repoRoot);

  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, fixtureText);
  writeFileSync(hashPath, hashText);

  console.log(`wrote ${fixturePath}`);
  console.log(`wrote ${hashPath}`);
  console.log(`sha256 ${fixtureHash}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
