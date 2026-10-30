# Vendored qbit-js conformance fixtures

`@qbit-oss/protocol` installs from npm, and its tarball ships neither these
qbit Core-derived fixtures nor the scripts that generate them. The wallet's
conformance checks need both, so they are copied here unchanged from
[Qbit-Org/qbit-js](https://github.com/Qbit-Org/qbit-js) at the signed tag
`v0.1.1`, commit `1cbf4b3e8fd3c7e51eba0d953910d5dafc9ae88f` (the commit the
pinned npm release was published from, see
`scripts/security/sdk-package-pins.json`). Each file's git blob ID equals
the upstream one:

| File | Upstream path | Git blob |
| --- | --- | --- |
| `fixtures/p2mr-sighash.json` | `packages/protocol/fixtures/p2mr-sighash.json` | `3740898d583fc75c33ee0640845192571483eb10` |
| `fixtures/p2mr-psbt.json` | `packages/protocol/fixtures/p2mr-psbt.json` | `f09af4387649b923aa90315d6b44369dfc901d81` |
| `scripts/gen-sighash-fixtures.py` | `packages/protocol/scripts/gen-sighash-fixtures.py` | `36f5f9ef89ef3f8db538b4c5c6f18f40490da798` |
| `scripts/gen-psbt-fixtures.py` | `packages/protocol/scripts/gen-psbt-fixtures.py` | `0e2e57d56c993b0cfe81422765af3b2f2c47c3bf` |

qbit-js is MIT licensed (Copyright (c) 2026 The qbit-js developers); the
generators carry their own attribution for the portions they adapt. Both
fixtures are generated from Qbit-Org/qbit v1.0.0
(`7ebcddb622d6e639041f005a189b048ec2a221fe`) by the scripts beside them.

`scripts/conformance/protocol-package-vectors.test.mjs` runs both fixtures
against the installed `@qbit-oss/protocol`. `pnpm conformance:fixtures:core`
regenerates them from a qbit Core checkout with these scripts, and the
conformance workflow compares the result with these files. Update them only
together with the `@qbit-oss/protocol` pin, from the commit it was published
from.
