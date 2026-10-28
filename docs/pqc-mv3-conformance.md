# @qbit-oss/pqc MV3 Conformance

`@qbit-oss/pqc` ships an Emscripten ES module loader plus a separate local
`pqc.wasm` file. Chrome MV3 extension service workers must load both artifacts
from the packaged extension, not from a remote URL.

## Required MV3 CSP

MV3 manifests that load `@qbit-oss/pqc` need extension-page CSP that permits local
WASM compilation:

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

Keep script sources restricted to `'self'`. Do not add remote script hosts or
plain `'unsafe-eval'` for PQC. The `wasm-unsafe-eval` token is required because
Chrome treats WebAssembly compilation as a separate CSP capability.

## Service Worker Loading

Use a module service worker:

```json
{
  "background": {
    "service_worker": "background.mjs",
    "type": "module"
  }
}
```

Chrome MV3 service workers should statically import the Emscripten factory and
pass it to `init()`:

```js
import { init } from '@qbit-oss/pqc'
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs'

const pqc = await init({
  createModule: createPqcModule,
  locateFile: path => chrome.runtime.getURL(`wasm/${path}`),
})
```

The extension bundle must package `pqc.wasm` next to the loader path resolved by
`locateFile`. Passing `locateFile` also keeps `init()` from using the copy of
`pqc.wasm` that `@qbit-oss/pqc` 0.1.0 embeds in `lib/index.mjs`. The
`apps/extension` smoke is a build/package gate: it statically imports both
`@qbit-oss/pqc` and `@qbit-oss/pqc/wasm/pqc.mjs`, emits an `init` entry with
`createModule` and `locateFile`, verifies the checked-in MV3 CSP, and proves
`wasm/pqc.wasm` is packaged byte-for-byte from the installed `@qbit-oss/pqc`
npm package.

## CI Commands

`@qbit-oss/pqc` is built, tested (including its Chrome MV3 service-worker
smoke) and reproducibly rebuilt in `Qbit-Org/qbit-pqc`, which publishes it to
npm with provenance from its signed tag. The wallet's PQC workflow runs:

```sh
pnpm pqc:golden:verify:committed
pnpm sdk:packages:check
pnpm test:pqc-golden
pnpm --filter qbit-extension smoke:pqc-import
```

`sdk:packages:check` holds the installed SDK packages to
`scripts/security/sdk-package-pins.json`: one copy of each at the pinned
version and registry integrity, with `@qbit-oss/pqc`'s `wasm/pqc.mjs` and
`wasm/pqc.wasm` matching both the package's `wasm/SHA256SUMS` and the pinned
digests. `test:pqc-golden` runs the
committed SLH-DSA golden vectors and the package's qbit Core derivation and
signature vectors against the installed package.

Maintainers can additionally run the full upstream-regeneration check locally
when they have access to the pinned upstream checkout:

```sh
pnpm pqc:golden:prepare
pnpm pqc:golden:verify
```

## Security Checklist

- Zeroization: entropy, secret-key, signature, and stats scratch buffers copied
  into the WASM heap are zeroed before `_free`; tests must keep covering failure
  paths.
- No secret-key logging: scripts and tests may compare fixture hex internally,
  but must not log generated secret keys, signatures, entropy, or full key hex
  dumps.
- Local WASM packaging: ship `pqc.mjs` and `pqc.wasm` from the package; do not
  fetch PQC WASM from a CDN or app backend.
- Pinned WASM: `sdk:packages:check` and the extension package test must match
  the digests in `scripts/security/sdk-package-pins.json`. The reproducible
  rebuild from the pinned Emscripten image runs in `Qbit-Org/qbit-pqc`.
- CSP: MV3 manifests must include `'wasm-unsafe-eval'` with `'self'` script
  sources and must not loosen CSP beyond the WASM requirement.
