#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const conformanceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(conformanceRoot, "..");
const suitePath = resolve(conformanceRoot, "suite.json");
const failures = [];

function fail(location, message) {
  failures.push(`${location}: ${message}`);
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(path, `invalid JSON (${error.message})`);
    return undefined;
  }
}

function repoPath(raw, location) {
  if (typeof raw !== "string" || !raw || raw.includes("\\")) {
    fail(location, "fixture path must be a non-empty forward-slash path");
    return undefined;
  }
  const target = resolve(repositoryRoot, raw);
  if (target !== repositoryRoot && !target.startsWith(repositoryRoot + sep)) {
    fail(location, "fixture path escapes the repository root");
    return undefined;
  }
  return target;
}

function isCanonicalTextFixture(fixture) {
  const mediaType = fixture.mediaType?.toLowerCase();
  return typeof mediaType === "string" && (
    mediaType.startsWith("text/") ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml") ||
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "application/vnd.jgraph.mxfile" ||
    mediaType === "image/svg+xml"
  );
}

const suite = await json(suitePath);
if (!suite) process.exitCode = 1;
else {
  if (suite.schemaVersion !== "0.1") fail("suite.json", "unsupported schemaVersion");
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    fail("suite.json", "cases must be a non-empty array");
  }

  const ids = new Set();
  const paths = new Set();
  for (const [index, rawCasePath] of (suite.cases ?? []).entries()) {
    if (paths.has(rawCasePath)) fail("suite.json", `duplicate case path ${rawCasePath}`);
    paths.add(rawCasePath);
    const casePath = repoPath(rawCasePath, `suite.json cases[${index}]`);
    if (!casePath) continue;
    const testCase = await json(casePath);
    if (!testCase) continue;

    const location = rawCasePath;
    for (const key of [
      "$schema",
      "schemaVersion",
      "id",
      "title",
      "status",
      "area",
      "operation",
      "input",
      "expected"
    ]) {
      if (!(key in testCase)) fail(location, `missing required field ${key}`);
    }
    if (testCase.schemaVersion !== "0.1") fail(location, "unsupported schemaVersion");
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(testCase.id ?? "")) {
      fail(location, "invalid case id");
    }
    if (ids.has(testCase.id)) fail(location, `duplicate case id ${testCase.id}`);
    ids.add(testCase.id);
    if (!["active", "draft"].includes(testCase.status)) fail(location, "invalid status");
    if (!["accepted", "rejected"].includes(testCase.expected?.outcome)) {
      fail(location, "invalid expected outcome");
    }
    if (!Array.isArray(testCase.expected?.assertions)) {
      fail(location, "expected.assertions must be an array");
    }
    if (!Array.isArray(testCase.input?.fixtures) || testCase.input.fixtures.length === 0) {
      fail(location, "input.fixtures must be a non-empty array");
      continue;
    }

    for (const [fixtureIndex, fixture] of testCase.input.fixtures.entries()) {
      const fixtureLocation = `${location} fixtures[${fixtureIndex}]`;
      const choices = Number(typeof fixture.path === "string") + Number(typeof fixture.bytesBase64 === "string");
      if (choices !== 1) fail(fixtureLocation, "provide exactly one of path or bytesBase64");
      if (fixture.path) {
        const target = repoPath(fixture.path, fixtureLocation);
        if (target) {
          try {
            if (!(await stat(target)).isFile()) fail(fixtureLocation, "fixture is not a file");
            const contents = await readFile(target);
            if (isCanonicalTextFixture(fixture) && contents.includes(0x0d)) {
              fail(fixtureLocation, "text fixture must use canonical LF line endings");
            }
            if (fixture.sha256) {
              const digest = createHash("sha256").update(contents).digest("hex");
              if (digest !== fixture.sha256) fail(fixtureLocation, "sha256 does not match fixture");
            }
          } catch (error) {
            fail(fixtureLocation, `fixture cannot be read (${error.message})`);
          }
        }
      } else if (fixture.bytesBase64) {
        const decoded = Buffer.from(fixture.bytesBase64, "base64");
        if (decoded.toString("base64") !== fixture.bytesBase64) {
          fail(fixtureLocation, "bytesBase64 is not canonical base64");
        }
      }
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  console.error(`Conformance metadata validation failed with ${failures.length} issue(s).`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${suite.cases.length} conformance cases and their fixtures.`);
}
