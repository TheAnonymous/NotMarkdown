import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach } from "vitest";

afterEach(() => cleanup());

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true
});

Object.defineProperty(URL, "createObjectURL", {
  value: () => "blob:notmarkdown-test",
  configurable: true
});

Object.defineProperty(URL, "revokeObjectURL", {
  value: () => undefined,
  configurable: true
});

if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}
