#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/golden-vectors-from-rust.mjs";
import {
  expectedSlhDsaGoldenFiles,
  fixtureSha256Sidecar,
  readCommittedSlhDsaGoldenFiles,
  resolveUpstreamPath,
  sha256Hex,
  validateSlhDsaGoldenFixture,
} from "../src/slh-dsa-golden-fixture.mjs";

function scriptRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function parseArgs(argv) {
  const args = { repoRoot: scriptRepoRoot(), upstream: undefined, committedOnly: false };

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
    } else if (arg === "--committed-only") {
      args.committedOnly = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const committed = readCommittedSlhDsaGoldenFiles(args.repoRoot);
  const actualHash = sha256Hex(committed.fixtureText);
  const expectedHashText = fixtureSha256Sidecar(actualHash);

  validateSlhDsaGoldenFixture(committed.fixture);
  if (canonicalJson(committed.fixture) !== committed.fixtureText) {
    throw new Error(`${committed.fixturePath} is not canonical JSON`);
  }
  if (committed.hashText !== expectedHashText) {
    throw new Error(`${committed.hashPath} does not match ${committed.fixturePath}`);
  }

  if (!args.committedOnly) {
    const upstreamPath = resolveUpstreamPath(args.repoRoot, args.upstream);
    const expected = expectedSlhDsaGoldenFiles(upstreamPath);
    if (committed.fixtureText !== expected.fixtureText) {
      throw new Error(
        `${committed.fixturePath} differs from ${upstreamPath}/${expected.fixture.source.path} at ${expected.fixture.source.commit}`,
      );
    }
    if (committed.hashText !== expected.hashText) {
      throw new Error(`${committed.hashPath} differs from regenerated hash sidecar`);
    }
  }

  console.log(`verified ${committed.fixturePath}`);
  console.log(`verified ${committed.hashPath}`);
  console.log(`sha256 ${actualHash}`);
  if (args.committedOnly) {
    console.log("verified committed fixture schema, canonical JSON, pinned source metadata, and sidecar hash");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
