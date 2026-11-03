---
'@qbit/wallet-shared': major
'@qbit/wallet-background': patch
---

Chrome MV3 is the only build target, so nothing reads the manifest version any more. Breaking change: `PlatformEnv` in `@qbit/wallet-shared` no longer has `MANIFEST_VERSION`; code that reads or sets it must drop it.

`@qbit/wallet-background`'s phishing controller uses DNR whenever `chrome.declarativeNetRequest` exists, without checking the manifest version. In a browser without that API the content script stays the only layer and the network rule health still reads `unsupported`. The package's unused, unexported copy of the extension's browser API wrappers (`src/webapi/browser.ts`) is removed.
