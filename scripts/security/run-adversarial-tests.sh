#!/usr/bin/env bash
set -euo pipefail

corepack pnpm run test:security-tooling

corepack pnpm --filter @qbit/keyring-service exec vitest run \
  test/browser-encryptor.test.ts \
  test/qbit-hd-keyring.test.ts \
  test/qbit-receive-intents.test.ts \
  test/secret-persistence.test.ts

corepack pnpm --filter @qbit/wallet-background exec vitest run \
  test/phishing-controller.test.ts \
  test/provider-origin.test.ts \
  test/provider-rpc-security.test.ts \
  test/provider-qbit-send.test.ts \
  test/qbit-api.test.ts \
  test/qbit-send-guards.test.ts \
  test/ui-access.test.ts \
  test/wallet-controller-qbit-send.test.ts \
  test/wallet-controller-restore-floors.test.ts

corepack pnpm --filter qbit-extension exec vitest run \
  src/background/runtime/messaging.test.ts \
  src/content-script/pageProvider/provider-v1-flow.integration.test.ts \
  src/ui/pages/Approval/components/ApprovalErrors.test.tsx \
  src/ui/pages/Approval/components/SignMessage.test.tsx

corepack pnpm --filter qbit-extension exec node --test \
  scripts/deterministic-package.test.js \
  scripts/package-artifact-validation.test.js

# The SDK's own Esplora-client and WASM-load tests ship with the Qbit-Org
# repositories, not the npm tarballs; here the installed copies and the PQC
# WASM are held to the committed pins.
corepack pnpm run sdk:packages:check
