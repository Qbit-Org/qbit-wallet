# Qbit Wallet Browser Extension

Qbit Wallet is a browser extension focused around the Qbit ecosystem.

- Website: https://qbit.org

## How to build

- Install [Node.js](https://nodejs.org) at the version in [`.nvmrc`](../../.nvmrc)
- From the repository root, install dependencies and build the `@qbit/*` workspace packages, which the extension imports from their build output: `pnpm install --frozen-lockfile && pnpm build`
- In this folder (`apps/extension`), build the project to the `./dist/` folder with `pnpm build:chrome:mv3` for the Chrome Web Store (Manifest V3)
- Develop: `pnpm build:chrome:mv3:dev` rebuilds the bundles in `./dist/chrome/` on every change. It does not write `manifest.json`, so run `pnpm build:chrome:mv3` once first
