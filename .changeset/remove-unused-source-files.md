---
'@qbit/wallet-state': patch
---

Remove the `useInfiniteList` hook (`src/ui-hooks/useInfiniteList.ts`), a source file nothing imported. The package's entry points (`.` and `./types`) never reached it, so what the package exports is unchanged.
