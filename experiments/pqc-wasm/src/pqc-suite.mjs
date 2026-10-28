const textEncoder = new TextEncoder();

export function deterministicEntropy(seedByte) {
  return Uint8Array.from({ length: 128 }, (_, i) => (seedByte + ((i * 37) % 256)) & 0xff);
}

export function deterministicBytes(length, seedByte) {
  return Uint8Array.from({ length }, (_, i) => (seedByte + ((i * 29) % 256)) & 0xff);
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have an even length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertHexEqual(label, actual, expectedHex) {
  const actualHex = bytesToHex(actual);
  if (actualHex !== expectedHex) {
    throw new Error(`${label} mismatch`);
  }
}

function vectorMessage(vector) {
  if (typeof vector.messageHex === "string") {
    return hexToBytes(vector.messageHex);
  }
  if (typeof vector.messageUtf8 === "string") {
    return textEncoder.encode(vector.messageUtf8);
  }
  throw new Error(`vector ${vector.name} is missing message data`);
}

function percentile(sortedSamples, pct) {
  const index = Math.max(0, Math.ceil((pct / 100) * sortedSamples.length) - 1);
  return sortedSamples[index];
}

async function measureOperation(operation, fn, { iterations, warmup }) {
  for (let i = 0; i < warmup; i += 1) {
    await fn(i);
  }

  const samplesMs = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await fn(i);
    samplesMs.push(performance.now() - started);
  }

  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    operation,
    iterations,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    samplesMs,
  };
}

function memorySnapshot(client) {
  const snapshot = {
    wasmHeapBytes: client.wasmHeapBytes(),
  };

  if (typeof process !== "undefined" && typeof process.memoryUsage === "function") {
    const usage = process.memoryUsage();
    snapshot.nodeRssBytes = usage.rss;
    snapshot.nodeHeapUsedBytes = usage.heapUsed;
    snapshot.nodeExternalBytes = usage.external;
  }

  if (performance && performance.memory) {
    snapshot.browserJsHeapUsedBytes = performance.memory.usedJSHeapSize;
    snapshot.browserJsHeapTotalBytes = performance.memory.totalJSHeapSize;
    snapshot.browserJsHeapLimitBytes = performance.memory.jsHeapSizeLimit;
  }

  return snapshot;
}

export async function runCorrectness(client, vectors) {
  const results = [];

  for (const vector of vectors) {
    const entropy = deterministicEntropy(vector.seedByte);
    const message = vectorMessage(vector);
    const { publicKey, secretKey } = client.keygen(entropy);

    assertHexEqual(`${vector.name} public key`, publicKey, vector.publicKeyHex);
    assertHexEqual(`${vector.name} secret key`, secretKey, vector.secretKeyHex);

    if (!client.secretKeyValidate(secretKey)) {
      throw new Error(`${vector.name} secret key did not validate`);
    }

    const signature = client.sign(secretKey, message);
    assertHexEqual(`${vector.name} signature`, signature, vector.signatureHex);

    if (!client.verify(publicKey, message, signature)) {
      throw new Error(`${vector.name} signature did not verify`);
    }

    const flippedSignature = signature.slice();
    flippedSignature[0] ^= 0x01;
    if (client.verify(publicKey, message, flippedSignature)) {
      throw new Error(`${vector.name} bit-flipped signature unexpectedly verified`);
    }

    const truncatedSignature = signature.slice(0, signature.length - 1);
    if (client.verify(publicKey, message, truncatedSignature)) {
      throw new Error(`${vector.name} truncated signature unexpectedly verified`);
    }

    const malformedSecretKey = secretKey.slice();
    malformedSecretKey[0] ^= 0x01;
    if (client.secretKeyValidate(malformedSecretKey)) {
      throw new Error(`${vector.name} malformed secret key unexpectedly validated`);
    }

    results.push({
      name: vector.name,
      seedByte: vector.seedByte,
      messageLength: message.length,
      ok: true,
    });
  }

  return results;
}

export async function runBenchmarks(client, { iterations = 20, warmup = 2 } = {}) {
  const benchKey = client.keygen(deterministicEntropy(0x41));
  const shortMessage = textEncoder.encode("golden-short");
  const digestMessage = deterministicBytes(32, 0x77);
  const digestSignature = client.sign(benchKey.secretKey, digestMessage);

  let keygenSeed = 0x80;
  const operations = [
    {
      operation: "keygen",
      fn: () => {
        keygenSeed = (keygenSeed + 1) & 0xff;
        client.keygen(deterministicEntropy(keygenSeed));
      },
    },
    {
      operation: "sign short message",
      fn: () => {
        client.sign(benchKey.secretKey, shortMessage);
      },
    },
    {
      operation: "sign 32-byte message",
      fn: () => {
        client.sign(benchKey.secretKey, digestMessage);
      },
    },
    {
      operation: "verify 32-byte message",
      fn: () => {
        if (!client.verify(benchKey.publicKey, digestMessage, digestSignature)) {
          throw new Error("benchmark verify failed");
        }
      },
    },
  ];

  const results = [];
  for (const operation of operations) {
    results.push(await measureOperation(operation.operation, operation.fn, { iterations, warmup }));
  }

  return results;
}

export async function runB1Suite({
  createClient,
  vectors,
  env,
  variant,
  iterations = 20,
  warmup = 2,
} = {}) {
  const loadStarted = performance.now();
  const client = await createClient();
  const loadMs = performance.now() - loadStarted;
  const afterLoad = memorySnapshot(client);

  const correctness = await runCorrectness(client, vectors);
  const afterCorrectness = memorySnapshot(client);

  const benchmarks = await runBenchmarks(client, { iterations, warmup });
  const afterBenchmarks = memorySnapshot(client);

  return {
    env,
    variant,
    iterations,
    warmup,
    loadMs,
    sizes: client.sizes,
    correctness,
    benchmarks,
    memory: {
      afterLoad,
      afterCorrectness,
      afterBenchmarks,
    },
  };
}
