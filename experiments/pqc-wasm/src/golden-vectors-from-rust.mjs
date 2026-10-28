import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bytesToHex, deterministicBytes } from "./pqc-suite.mjs";

export const SLH_DSA_GOLDEN_SOURCE = {
  repository: "Qbit-Org/qbit-libbitcoinpqc",
  commit: "d165da6a1535965d1f369000f396bd2de2db1d4d",
  path: "tests/golden_vector_tests.rs",
  gitBlob: "57d0d702859b00b8393684bde573679c94670298",
  sha256: "3dc5ef94de0e73a8635e23fdb01d54ab340abaa8938922975a67343e4783b9bf",
};

const CONSTANTS = {
  short: {
    pk: "GOLDEN_SHORT_PK_HEX",
    sk: "GOLDEN_SHORT_SK_HEX",
    sig: "GOLDEN_SHORT_SIG_HEX",
  },
  empty: {
    pk: "GOLDEN_EMPTY_PK_HEX",
    sk: "GOLDEN_EMPTY_SK_HEX",
    sig: "GOLDEN_EMPTY_SIG_HEX",
  },
  oneKb: {
    pk: "GOLDEN_1KB_PK_HEX",
    sk: "GOLDEN_1KB_SK_HEX",
    sig: "GOLDEN_1KB_SIG_HEX",
  },
};

const SIZE_CONSTANTS = {
  minEntropyBytes: "MIN_ENTROPY_LEN",
  publicKeyBytes: "BOUNDED30_PUBLIC_KEY_SIZE",
  secretKeyBytes: "BOUNDED30_SECRET_KEY_SIZE",
  signatureBytes: "BOUNDED30_SIGNATURE_SIZE",
};

function rustUsizeConst(rust, name) {
  const re = new RegExp(`const ${name}: usize =\\s*([0-9]+);`, "m");
  const match = rust.match(re);
  if (!match) {
    throw new Error(`missing Rust usize constant ${name}`);
  }

  return Number.parseInt(match[1], 10);
}

function rustStringConst(rust, name) {
  const re = new RegExp(`const ${name}: &str =\\s*((?:\\s*"[^"]*"\\s*)+);`, "m");
  const match = rust.match(re);
  if (!match) {
    throw new Error(`missing Rust string constant ${name}`);
  }

  return Array.from(match[1].matchAll(/"([^"]*)"/g), (part) => part[1])
    .join("")
    .replace(/[\s\\]/g, "");
}

export function parseGoldenVectorTests(rust) {
  const sizes = Object.fromEntries(
    Object.entries(SIZE_CONSTANTS).map(([fixtureName, rustName]) => [
      fixtureName,
      rustUsizeConst(rust, rustName),
    ]),
  );

  return {
    sizes,
    vectors: [
      {
        name: "golden_vector_short_message",
        seedByte: 0x01,
        messageHex: bytesToHex(new TextEncoder().encode("golden-short")),
        publicKeyHex: rustStringConst(rust, CONSTANTS.short.pk),
        secretKeyHex: rustStringConst(rust, CONSTANTS.short.sk),
        signatureHex: rustStringConst(rust, CONSTANTS.short.sig),
      },
      {
        name: "golden_vector_empty_message",
        seedByte: 0x02,
        messageHex: "",
        publicKeyHex: rustStringConst(rust, CONSTANTS.empty.pk),
        secretKeyHex: rustStringConst(rust, CONSTANTS.empty.sk),
        signatureHex: rustStringConst(rust, CONSTANTS.empty.sig),
      },
      {
        name: "golden_vector_1kb_message",
        seedByte: 0x03,
        messageHex: bytesToHex(deterministicBytes(1024, 0x03)),
        publicKeyHex: rustStringConst(rust, CONSTANTS.oneKb.pk),
        secretKeyHex: rustStringConst(rust, CONSTANTS.oneKb.sk),
        signatureHex: rustStringConst(rust, CONSTANTS.oneKb.sig),
      },
    ],
  };
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildSlhDsaGoldenFixture({ rust, source = SLH_DSA_GOLDEN_SOURCE } = {}) {
  if (typeof rust !== "string") {
    throw new Error("buildSlhDsaGoldenFixture requires Rust source text");
  }

  const { sizes, vectors } = parseGoldenVectorTests(rust);
  return {
    schemaVersion: 1,
    algorithm: "SLH-DSA-SHA2-128s-bounded30",
    source,
    sizes,
    derivation: {
      entropy: "deterministic_entropy(seed): 128 bytes, byte[i] = seed + ((i * 37) % 256) mod 256",
      messages: {
        golden_vector_short_message: "utf8:golden-short",
        golden_vector_empty_message: "empty",
        golden_vector_1kb_message:
          "deterministic_bytes(1024, 0x03): byte[i] = 0x03 + ((i * 29) % 256) mod 256",
      },
    },
    vectors,
  };
}

export function loadGoldenVectors({
  repoRoot = process.cwd(),
  rustPath = join(repoRoot, ".context/repos/libbitcoinpqc-qbit/tests/golden_vector_tests.rs"),
} = {}) {
  const rust = readFileSync(rustPath, "utf8");
  return parseGoldenVectorTests(rust).vectors;
}

export function serializeGoldenVectorsModule(vectors) {
  return `export const vectors = ${JSON.stringify(vectors, null, 2)};\n`;
}
