import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundFailure } from "../apps/server/src/log.ts";

test("background failures retain safe error codes without logging messages", (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const error = Object.assign(new Error("postgres://user:secret@example.invalid/database"), {
    code: "57P01",
  });

  backgroundFailure("postgres pool", error);

  assert.equal(logged.mock.callCount(), 1);
  const [entry] = logged.mock.calls[0].arguments as [Record<string, unknown>];
  assert.equal(entry.error, "Error");
  assert.equal(entry.code, "57P01");
  assert.deepEqual(entry.context, { phase: "postgres pool" });
  assert.equal(JSON.stringify(entry).includes("secret"), false);
});

test("background failures omit unsafe code strings", (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const error = Object.assign(new Error("hidden"), { code: "postgres://secret" });

  backgroundFailure("background", error);

  const [entry] = logged.mock.calls[0].arguments as [Record<string, unknown>];
  assert.equal("code" in entry, false);
});
