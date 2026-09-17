import assert from "node:assert/strict";
import test from "node:test";
import { assertIdentity, expectedIdentity } from "../scripts/check-identity.ts";

const identity = `${expectedIdentity} 1789630000 +0900`;
const remote = "https://github.com/yukurash/voice-action-lab.git";

test("the owner identity and HTTPS remote are accepted", () => {
  assert.doesNotThrow(() => assertIdentity("yukurash", identity, identity, remote));
});

test("another authenticated account cannot ship", () => {
  assert.throws(
    () => assertIdentity("different-account", identity, identity, remote),
    /authentication/,
  );
});

test("environment overrides of author or committer cannot ship", () => {
  assert.throws(
    () => assertIdentity("yukurash", "other <other@example.com> 1 +0000", identity, remote),
    /author/,
  );
  assert.throws(
    () => assertIdentity("yukurash", identity, "other <other@example.com> 1 +0000", remote),
    /committer/,
  );
});

test("another owner or credential-bearing remote cannot ship", () => {
  for (const value of [
    "https://github.com/another/voice-action-lab.git",
    "https://user:password@github.com/yukurash/voice-action-lab.git",
    "git@github.com:yukurash/voice-action-lab.git",
  ]) assert.throws(
    () => assertIdentity("yukurash", identity, identity, value),
    /remote/,
  );
});

test("a name containing the expected identity cannot spoof the complete identity", () => {
  assert.throws(
    () => assertIdentity(
      "yukurash", `${expectedIdentity} injected <other@example.com> 1 +0000`,
      identity, remote,
    ),
    /author/,
  );
});
