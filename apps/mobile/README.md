# Qbit Wallet for iOS (MVP)

The extension wallet, packaged as an iOS app with [Capacitor](https://capacitorjs.com).
The app runs the extension's background and UI unchanged inside one WebView.

## How it works

```
WKWebView  (capacitor://localhost/sidepanel.html)
├── src/chrome-shim     in-page stand-in for the chrome.* APIs the wallet uses
│   ├── runtime ports   in-memory, JSON-serialized, async, Chrome disconnect semantics
│   └── storage.local   write-through to @capacitor/preferences (iOS UserDefaults)
├── extension background (apps/extension/src/background)  ← booted first
└── extension UI         (apps/extension/src/ui)          ← connects over a port
```

- `src/index.ts` loads persisted storage, installs the stand-in as the global `chrome`, then
  imports the background and the UI, in that order.
- The page is served as `sidepanel.html` so the UI picks its full-height, narrow layout.
- `MainViewController` (in `ios/App/App/AppDelegate.swift`) keeps the WebView inside the safe
  area, so the wallet's `100vw`/`100vh` layout fits the screen without phone-specific CSS.
- `webpack.config.js` reuses the extension's webpack config and only swaps the entry, the HTML
  pages and the output folder (`www/`).
- PQC signing uses the same `@qbit-oss/pqc` WebAssembly build as the extension.

## Prerequisites

- Xcode with an iOS Simulator runtime (Xcode → Settings → Components, or
  `xcodebuild -downloadPlatform iOS`).
- If `xcode-select -p` points at the Command Line Tools, either run
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` or prefix the CLI
  commands below with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- Node 22 and pnpm via corepack, as for the rest of the repo.

## Run it in the simulator

From the repo root:

```sh
corepack pnpm install
corepack pnpm test:e2e:prepare      # builds the workspace packages the wallet imports
cd apps/mobile
corepack pnpm build:ios             # webpack bundle → www/, then `cap sync ios`
corepack pnpm open:ios              # opens ios/App/App.xcodeproj in Xcode
```

In Xcode pick an iPhone simulator and press Run. The first build fetches the Capacitor Swift
package from GitHub.

Without opening Xcode:

```sh
cd apps/mobile/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build build
xcrun simctl boot 'iPhone 17'; open -a Simulator
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted org.qbit.wallet
```

Use `xcrun simctl list devices available` for the simulator names your runtime provides. Some
runtime builds support only certain devices; `xcrun simctl list runtimes -j` lists each runtime's
`supportedDeviceTypes`.

After changing wallet code, re-run `corepack pnpm build:ios` and run again. Debug builds can be
inspected from Safari → Develop → Simulator.

## Tests

```sh
corepack pnpm --filter qbit-mobile test   # chrome stand-in unit tests
```

The bundle can also be smoke-tested in a desktop browser: serve `www/` over `http://localhost`
and open it at phone size. Capacitor's web fallbacks store data in `localStorage` there.

## What is not in the MVP

- **dApp connections.** There is no injected `window.qbit` on mobile. Approval windows are
  refused, so any dApp request is rejected.
- **Biometric unlock.** The extension's WebAuthn unlock is bound to the extension origin, so it
  is hidden; unlock uses the password. Native Keychain/Face ID unlock is a follow-up.
- **Keychain storage.** The vault (already encrypted with the wallet password) is stored in
  UserDefaults through `@capacitor/preferences`. Moving it to the Keychain is a follow-up.
- **Regtest.** The local-regtest permission is never granted, so regtest stays locked.
- **Android.** Only the iOS platform has been added (`npx cap add android` is the next step).
- **Release work.** Signing team, App Store metadata, and the dependency license/inventory
  refresh for the new Capacitor packages (`scripts/security/dependency-policy.mjs`).
