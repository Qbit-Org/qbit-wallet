const OK = 0;

function assertUint8Array(name, value) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
}

function assertLength(name, value, expected) {
  if (value.length !== expected) {
    throw new RangeError(`${name} must be ${expected} bytes, got ${value.length}`);
  }
}

function malloc(module, byteLength) {
  const ptr = module._malloc(Math.max(1, byteLength));
  if (!ptr) {
    throw new Error(`WASM malloc failed for ${byteLength} bytes`);
  }
  return ptr;
}

function zero(module, ptr, byteLength) {
  if (ptr && byteLength > 0) {
    module.HEAPU8.fill(0, ptr, ptr + byteLength);
  }
}

function copyIn(module, bytes) {
  const ptr = malloc(module, bytes.length);
  module.HEAPU8.set(bytes, ptr);
  return ptr;
}

function copyOut(module, ptr, byteLength) {
  return module.HEAPU8.slice(ptr, ptr + byteLength);
}

export async function createPqcClient({ createModule, moduleOptions = {} }) {
  if (typeof createModule !== "function") {
    throw new TypeError("createModule must be the Emscripten factory function");
  }

  const module = await createModule(moduleOptions);
  const sizes = {
    publicKey: module._qbit_pqc_public_key_size(),
    secretKey: module._qbit_pqc_secret_key_size(),
    signature: module._qbit_pqc_signature_size(),
    entropyMin: module._qbit_pqc_keygen_entropy_min_size(),
  };

  function keygen(entropy) {
    assertUint8Array("entropy", entropy);
    if (entropy.length < sizes.entropyMin) {
      throw new RangeError(`entropy must be at least ${sizes.entropyMin} bytes`);
    }

    let entropyPtr = 0;
    let publicKeyPtr = 0;
    let secretKeyPtr = 0;
    try {
      entropyPtr = copyIn(module, entropy);
      publicKeyPtr = malloc(module, sizes.publicKey);
      secretKeyPtr = malloc(module, sizes.secretKey);

      const rc = module._qbit_pqc_keygen(publicKeyPtr, secretKeyPtr, entropyPtr, entropy.length);
      if (rc !== OK) {
        throw new Error(`qbit_pqc_keygen failed with rc=${rc}`);
      }

      return {
        publicKey: copyOut(module, publicKeyPtr, sizes.publicKey),
        secretKey: copyOut(module, secretKeyPtr, sizes.secretKey),
      };
    } finally {
      zero(module, entropyPtr, entropy.length);
      zero(module, secretKeyPtr, sizes.secretKey);
      if (entropyPtr) module._free(entropyPtr);
      if (publicKeyPtr) module._free(publicKeyPtr);
      if (secretKeyPtr) module._free(secretKeyPtr);
    }
  }

  function secretKeyValidate(secretKey) {
    assertUint8Array("secretKey", secretKey);
    let secretKeyPtr = 0;
    try {
      if (secretKey.length > 0) {
        secretKeyPtr = copyIn(module, secretKey);
      }
      const rc = module._qbit_pqc_secret_key_validate(secretKeyPtr, secretKey.length);
      return rc === OK;
    } finally {
      zero(module, secretKeyPtr, secretKey.length);
      if (secretKeyPtr) module._free(secretKeyPtr);
    }
  }

  function sign(secretKey, message) {
    assertUint8Array("secretKey", secretKey);
    assertUint8Array("message", message);
    assertLength("secretKey", secretKey, sizes.secretKey);

    // qbit's SLH-DSA API is stateless: bitcoin_pqc_sign takes a const
    // secret key and does not return updated key material.
    let secretKeyPtr = 0;
    let messagePtr = 0;
    let signaturePtr = 0;
    try {
      secretKeyPtr = copyIn(module, secretKey);
      if (message.length > 0) {
        messagePtr = copyIn(module, message);
      }
      signaturePtr = malloc(module, sizes.signature);

      const rc = module._qbit_pqc_sign(signaturePtr, secretKeyPtr, messagePtr, message.length);
      if (rc !== OK) {
        throw new Error(`qbit_pqc_sign failed with rc=${rc}`);
      }

      return copyOut(module, signaturePtr, sizes.signature);
    } finally {
      zero(module, secretKeyPtr, secretKey.length);
      if (secretKeyPtr) module._free(secretKeyPtr);
      if (messagePtr) module._free(messagePtr);
      if (signaturePtr) module._free(signaturePtr);
    }
  }

  function signWithStats(secretKey, message) {
    assertUint8Array("secretKey", secretKey);
    assertUint8Array("message", message);
    assertLength("secretKey", secretKey, sizes.secretKey);

    // qbit's SLH-DSA API is stateless: bitcoin_pqc_sign_with_stats takes a
    // const secret key and does not return updated key material.
    let secretKeyPtr = 0;
    let messagePtr = 0;
    let signaturePtr = 0;
    let statsPtr = 0;
    try {
      secretKeyPtr = copyIn(module, secretKey);
      if (message.length > 0) {
        messagePtr = copyIn(module, message);
      }
      signaturePtr = malloc(module, sizes.signature);
      statsPtr = malloc(module, 11 * 4);

      const rc = module._qbit_pqc_sign_with_stats(
        signaturePtr,
        statsPtr,
        secretKeyPtr,
        messagePtr,
        message.length,
      );
      if (rc !== OK) {
        throw new Error(`qbit_pqc_sign_with_stats failed with rc=${rc}`);
      }

      const statsRaw = new Uint32Array(module.HEAPU8.buffer, statsPtr, 11);
      return {
        signature: copyOut(module, signaturePtr, sizes.signature),
        stats: {
          forscAttempts: statsRaw[0],
          forscMaxAttempts: statsRaw[1],
          wotscAttempts: Array.from(statsRaw.slice(2, 7)),
          wotscLayerCount: statsRaw[7],
          wotscMaxAttempts: statsRaw[8],
          wotscMaxObservedAttempts: statsRaw[9],
          capExceeded: statsRaw[10],
        },
      };
    } finally {
      zero(module, secretKeyPtr, secretKey.length);
      if (secretKeyPtr) module._free(secretKeyPtr);
      if (messagePtr) module._free(messagePtr);
      if (signaturePtr) module._free(signaturePtr);
      if (statsPtr) module._free(statsPtr);
    }
  }

  function verify(publicKey, message, signature) {
    assertUint8Array("publicKey", publicKey);
    assertUint8Array("message", message);
    assertUint8Array("signature", signature);
    assertLength("publicKey", publicKey, sizes.publicKey);

    let publicKeyPtr = 0;
    let messagePtr = 0;
    let signaturePtr = 0;
    try {
      publicKeyPtr = copyIn(module, publicKey);
      if (message.length > 0) {
        messagePtr = copyIn(module, message);
      }
      if (signature.length > 0) {
        signaturePtr = copyIn(module, signature);
      }

      const rc = module._qbit_pqc_verify(
        publicKeyPtr,
        messagePtr,
        message.length,
        signaturePtr,
        signature.length,
      );
      return rc === OK;
    } finally {
      if (publicKeyPtr) module._free(publicKeyPtr);
      if (messagePtr) module._free(messagePtr);
      if (signaturePtr) module._free(signaturePtr);
    }
  }

  return {
    module,
    sizes,
    keygen,
    sign,
    signWithStats,
    verify,
    secretKeyValidate,
    wasmHeapBytes: () => module.HEAPU8.byteLength,
  };
}
