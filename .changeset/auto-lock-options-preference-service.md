---
'@qbit/preference-service': major
---

Breaking change: `getAutoLockTimeId()` returns an auto-lock time id offered now (`resolveAutoLockTimeId`, `@qbit/wallet-shared`), not the stored value as it is: a retired id gives the id that replaced it, and any other value that is no id offered now gives the shortest time, 5 minutes (id 3). Breaking change: `init` writes the auto-lock time when the stored one needs repair (`repairStoredAutoLockTimeId`), before it resolves rather than after the store's debounced save: a retired id is stored as its replacement, and a value that is no whole number of zero or more (`null`, a string, a fractional or negative number) as the shortest time. A failed save is logged and left to the debounced save. A missing value, an id offered now, and a whole number that is neither offered nor retired, which a later build may have stored, stay on disk and add no write. The store's format is unchanged. A new store starts at the new default, 30 minutes (id 5).
