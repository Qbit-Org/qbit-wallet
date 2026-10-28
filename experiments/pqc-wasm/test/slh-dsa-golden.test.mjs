import { strict as assert } from "node:assert";
import { test } from "node:test";

import { canonicalJson } from "../src/golden-vectors-from-rust.mjs";
import {
  fixtureSha256Sidecar,
  readCommittedSlhDsaGoldenFiles,
  sha256Hex,
  validateSlhDsaGoldenFixture,
} from "../src/slh-dsa-golden-fixture.mjs";

test("SLH-DSA golden fixture is canonical and hash-pinned", () => {
  const committed = readCommittedSlhDsaGoldenFiles();

  validateSlhDsaGoldenFixture(committed.fixture);
  assert.equal(canonicalJson(committed.fixture), committed.fixtureText);

  const actualHash = sha256Hex(committed.fixtureText);
  assert.equal(committed.hashText, fixtureSha256Sidecar(actualHash));
});
