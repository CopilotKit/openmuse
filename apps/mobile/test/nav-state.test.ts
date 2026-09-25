import assert from "node:assert/strict";
import test from "node:test";
import {
  closeNav,
  createEscapeHandler,
  isNavOpen,
  openNav,
  subscribeNav,
  toggleNav,
} from "../src/nav/nav-state.ts";

test("drawer starts closed", () => {
  closeNav();
  assert.equal(isNavOpen(), false);
});

test("openNav opens and closeNav closes", () => {
  closeNav();
  openNav();
  assert.equal(isNavOpen(), true);
  closeNav();
  assert.equal(isNavOpen(), false);
});

test("toggleNav flips the state both ways", () => {
  closeNav();
  toggleNav();
  assert.equal(isNavOpen(), true);
  toggleNav();
  assert.equal(isNavOpen(), false);
});

test("redundant open/close calls do not notify twice", () => {
  closeNav();
  let calls = 0;
  const stop = subscribeNav(() => {
    calls += 1;
  });
  try {
    openNav();
    openNav();
    assert.equal(calls, 1);
    closeNav();
    closeNav();
    assert.equal(calls, 2);
  } finally {
    stop();
  }
});

test("unsubscribed listeners stop receiving updates", () => {
  closeNav();
  let calls = 0;
  const stop = subscribeNav(() => {
    calls += 1;
  });
  stop();
  openNav();
  assert.equal(calls, 0);
  closeNav();
});

test("toggleNav notifies subscribers once per flip", () => {
  closeNav();
  let calls = 0;
  const stop = subscribeNav(() => {
    calls += 1;
  });
  try {
    toggleNav();
    assert.equal(isNavOpen(), true);
    assert.equal(calls, 1);
    toggleNav();
    assert.equal(isNavOpen(), false);
    assert.equal(calls, 2);
  } finally {
    stop();
  }
});

test("escape handler closes only on the Escape key", () => {
  let escaped = 0;
  const handler = createEscapeHandler(() => {
    escaped += 1;
  });
  handler({ key: "Escape" });
  assert.equal(escaped, 1);
  handler({ key: "Enter" });
  handler({ key: "Escape " });
  handler({ key: "q" });
  assert.equal(escaped, 1);
});
