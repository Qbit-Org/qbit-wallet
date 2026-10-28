import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildSlhDsaGoldenFixture,
  canonicalJson,
  SLH_DSA_GOLDEN_SOURCE,
} from "./golden-vectors-from-rust.mjs";
import { bytesToHex, deterministicBytes } from "./pqc-suite.mjs";

export const FIXTURE_RELATIVE_PATH = "experiments/pqc-wasm/fixtures/slh-dsa-golden.json";
export const FIXTURE_HASH_RELATIVE_PATH =
  "experiments/pqc-wasm/fixtures/slh-dsa-golden.json.sha256";
export const DEFAULT_UPSTREAM_RELATIVE_PATH = ".context/repos/libbitcoinpqc-qbit";

const EXPECTED_VECTOR_NAMES = [
  "golden_vector_short_message",
  "golden_vector_empty_message",
  "golden_vector_1kb_message",
];

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertHexBytes(hex, bytes, label) {
  if (typeof hex !== "string" || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error(`${label}: expected lowercase hex`);
  }
  assertEqual(hex.length, bytes * 2, `${label} hex length`);
}

function git(upstreamPath, args) {
  return execFileSync("git", ["-C", upstreamPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function fixtureSha256Sidecar(hash) {
  return `${hash}  ${FIXTURE_RELATIVE_PATH}\n`;
}

export function fixturePaths(repoRoot = process.cwd()) {
  return {
    fixturePath: join(repoRoot, FIXTURE_RELATIVE_PATH),
    hashPath: join(repoRoot, FIXTURE_HASH_RELATIVE_PATH),
  };
}

export function resolveUpstreamPath(repoRoot = process.cwd(), upstreamPath) {
  return resolve(repoRoot, upstreamPath ?? DEFAULT_UPSTREAM_RELATIVE_PATH);
}

export function readPinnedRustFromGit(upstreamPath) {
  if (!existsSync(upstreamPath)) {
    throw new Error(`missing upstream checkout at ${upstreamPath}`);
  }

  let commit;
  let gitBlob;
  let rust;
  try {
    commit = git(upstreamPath, ["rev-parse", `${SLH_DSA_GOLDEN_SOURCE.commit}^{commit}`]).trim();
    gitBlob = git(upstreamPath, [
      "rev-parse",
      `${SLH_DSA_GOLDEN_SOURCE.commit}:${SLH_DSA_GOLDEN_SOURCE.path}`,
    ]).trim();
    rust = git(upstreamPath, [
      "show",
      `${SLH_DSA_GOLDEN_SOURCE.commit}:${SLH_DSA_GOLDEN_SOURCE.path}`,
    ]);
  } catch (error) {
    throw new Error(
      `could not read ${SLH_DSA_GOLDEN_SOURCE.path} from ${SLH_DSA_GOLDEN_SOURCE.repository}@${SLH_DSA_GOLDEN_SOURCE.commit} in ${upstreamPath}: ${error.message}`,
    );
  }

  const rustSha256 = sha256Hex(rust);
  assertEqual(commit, SLH_DSA_GOLDEN_SOURCE.commit, "upstream commit");
  assertEqual(gitBlob, SLH_DSA_GOLDEN_SOURCE.gitBlob, "upstream Rust file git blob");
  assertEqual(rustSha256, SLH_DSA_GOLDEN_SOURCE.sha256, "upstream Rust file sha256");

  return { rust, commit, gitBlob, rustSha256 };
}

export function expectedSlhDsaGoldenFiles(upstreamPath) {
  const { rust } = readPinnedRustFromGit(upstreamPath);
  const fixture = buildSlhDsaGoldenFixture({ rust });
  const fixtureText = canonicalJson(fixture);
  const fixtureHash = sha256Hex(fixtureText);

  return {
    fixture,
    fixtureText,
    fixtureHash,
    hashText: fixtureSha256Sidecar(fixtureHash),
  };
}

export function readCommittedSlhDsaGoldenFiles(repoRoot = process.cwd()) {
  const { fixturePath, hashPath } = fixturePaths(repoRoot);
  const fixtureText = readFileSync(fixturePath, "utf8");
  const hashText = readFileSync(hashPath, "utf8");

  return {
    fixturePath,
    hashPath,
    fixtureText,
    hashText,
    fixture: JSON.parse(fixtureText),
  };
}

export function validateSlhDsaGoldenFixture(fixture) {
  assertEqual(fixture.schemaVersion, 1, "schemaVersion");
  assertEqual(fixture.algorithm, "SLH-DSA-SHA2-128s-bounded30", "algorithm");
  assertEqual(fixture.source.repository, SLH_DSA_GOLDEN_SOURCE.repository, "source.repository");
  assertEqual(fixture.source.commit, SLH_DSA_GOLDEN_SOURCE.commit, "source.commit");
  assertEqual(fixture.source.path, SLH_DSA_GOLDEN_SOURCE.path, "source.path");
  assertEqual(fixture.source.gitBlob, SLH_DSA_GOLDEN_SOURCE.gitBlob, "source.gitBlob");
  assertEqual(fixture.source.sha256, SLH_DSA_GOLDEN_SOURCE.sha256, "source.sha256");
  assertEqual(fixture.sizes.minEntropyBytes, 128, "sizes.minEntropyBytes");
  assertEqual(fixture.sizes.publicKeyBytes, 32, "sizes.publicKeyBytes");
  assertEqual(fixture.sizes.secretKeyBytes, 64, "sizes.secretKeyBytes");
  assertEqual(fixture.sizes.signatureBytes, 3680, "sizes.signatureBytes");

  if (!Array.isArray(fixture.vectors)) {
    throw new Error("vectors must be an array");
  }
  assertEqual(fixture.vectors.length, EXPECTED_VECTOR_NAMES.length, "vectors.length");

  const expectedMessages = {
    golden_vector_short_message: bytesToHex(new TextEncoder().encode("golden-short")),
    golden_vector_empty_message: "",
    golden_vector_1kb_message: bytesToHex(deterministicBytes(1024, 0x03)),
  };

  fixture.vectors.forEach((vector, index) => {
    assertEqual(vector.name, EXPECTED_VECTOR_NAMES[index], `vectors[${index}].name`);
    assertEqual(vector.seedByte, index + 1, `vectors[${index}].seedByte`);
    assertEqual(vector.messageHex, expectedMessages[vector.name], `vectors[${index}].messageHex`);
    assertHexBytes(vector.publicKeyHex, fixture.sizes.publicKeyBytes, `${vector.name}.publicKeyHex`);
    assertHexBytes(vector.secretKeyHex, fixture.sizes.secretKeyBytes, `${vector.name}.secretKeyHex`);
    assertHexBytes(vector.signatureHex, fixture.sizes.signatureBytes, `${vector.name}.signatureHex`);
  });
}
