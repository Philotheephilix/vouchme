// @aval/gateway — src/resolve.test.ts
//
// Smoke tests for the pure, dependency-free parts of resolve.ts: DNS wire
// encoding and name/depth parsing. Run with `npm test` after `npm run
// build` (node's built-in test runner, no extra devDependency required).

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeDnsName, encodeDnsName, parseName } from "./resolve.js";

test("encodeDnsName / decodeDnsName round-trip", () => {
  const labels = ["carol", "alice", "aval", "eth"];
  const encoded = encodeDnsName(labels);
  assert.deepEqual(decodeDnsName(encoded), labels);
});

test("parseName computes depth from label count (docs/04-ens.md §1)", () => {
  const alice = parseName(encodeDnsName(["alice", "aval", "eth"]));
  assert.equal(alice?.depth, 1);

  const carol = parseName(encodeDnsName(["carol", "alice", "aval", "eth"]));
  assert.equal(carol?.depth, 2);
  assert.deepEqual(carol?.pathLabelsRootFirst, ["alice", "carol"]);

  const erin = parseName(encodeDnsName(["erin", "carol", "alice", "aval", "eth"]));
  assert.equal(erin?.depth, 3);
});

test("names beyond max_depth do not resolve (docs/04-ens.md §5.1)", () => {
  const tooDeep = parseName(encodeDnsName(["w", "x", "y", "z", "aval", "eth"]));
  assert.equal(tooDeep, null);
});

test("names outside aval.eth do not resolve", () => {
  const other = parseName(encodeDnsName(["alice", "example", "eth"]));
  assert.equal(other, null);
});
