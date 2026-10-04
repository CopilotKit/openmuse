# Strictness

OpenMuse is compiled and linted at maximum practical strictness. This file
records what that means concretely, and — more usefully — the handful of things
we deliberately do *not* enforce, with the reason. Re-enabling any of them needs
a code change, not a suppression comment.

## TypeScript

`tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noUnusedLocals`,
`noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
`noErrorTruncation`, `allowUnreachableCode: false` and `allowUnusedLabels: false`.

`pnpm typecheck` covers three separate programs and all three must pass:
`tsc --noEmit` (server, packages, tests), `apps/mobile`, and `apps/worker`.

`exactOptionalPropertyTypes` is the strictest flag here and the one with real
teeth: it rejects `{ key: maybeUndefined }` when the target declares
`key?: T`, because that is indistinguishable from "absent" at runtime. This
catches genuine bugs — a `fetch` GET that silently sends `Content-Type` it
should not, a task record that persists a field it meant to omit.

Two categories of code satisfy it:

- **Our own partial data.** Domain records round-trip through a jsonb KV table,
  so a field can legitimately be missing. Those interfaces declare
  `prop?: T | undefined` explicitly. This is honest about the shape, not a
  loophole: `undefined` is a real value there.
- **Third-party option objects.** Node's `fetch`, the E2B SDK, the model SDKs
  and Google APIs all predate the flag, so their option bags still mean
  "absent, never `undefined`". Call sites normalize through
  `packages/backends/src/strict-optional.ts`, whose `defined()` drops
  undefined-valued keys. Normalize at the choke point — the `json()` transport
  helper, a shared `opts()` builder — rather than sprinkling
  `...(x ? { x } : {})` at every call.

Where a single shared builder covers many call sites (OpenBot's `json()`, the
E2B `opts()`), fix the builder and widen that builder's own parameter type to
admit `undefined`. Fixing only the outermost object is not enough: spreading it
re-widens the keys.

## Biome

89 rules are pinned to `error` across `correctness`, `suspicious`, `style` and
`complexity`, well past the `recommended` preset. Notably:
`noExplicitAny`, `noShadow`, `noUnnecessaryConditions`, `noEvolvingTypes`,
noDoubleEquals, `noUnusedTemplateLiteral`, `noUnusedFunctionParameters`,
`noImplicitAnyLet`, `noUnassignedVariables`, `useFlatMap`,
`noUselessSwitchCase`, `noDuplicateDependencies`, `noAsyncPromiseExecutor`.

`biome.json` allows no unknown keys, so rationale for what is off lives here
rather than inline.

### Deliberately not enforced

- **`noEmptyBlockStatements`.** Fires on the `.catch(() => {})`
  best-effort-cleanup idiom used throughout the server and worker — deleting a
  temporary file, tearing down a sandbox, clearing a timer. A failed cleanup
  there genuinely is not actionable, and the empty block is what says so.
- **`noNestedPromises`.** Fires on `await x.catch(...)` inside a `.then`, which
  is the clearest way to express "await this, treat failure as null". Its
  suggested refactor — de-awaiting into promise chains — is strictly harder to
  read and no safer.
- **`noBitwiseOperators`, `noForEach`.** Style preferences this codebase does
  not follow. Not correctness signals, and turning them on would be churn.

## Tests

`pnpm test` needs a reachable Postgres:
`DATABASE_URL=postgresql://openmuse:openmuse@localhost:5432/openmuse_test`
(`make test` sets it).

**Tests that share a database must reset it.** `openmuse_test` is long-lived, so
a suite that does not clear its rows inherits the previous run's state and
eventually trips the 100-non-terminal-task cap with a 409 that looks like a
product bug. `Store.clearAll()` exists for exactly this. Prefer an isolated
PGlite store (`createStore({ dataDir })`) where the suite does not need real
Postgres.

**A latch must always be released.** When a test holds a promise open to observe
concurrent behaviour, release it in a `finally`. An assertion failure before the
release otherwise hangs the suite instead of failing it.

**New behaviour needs a test that fails without it.** For the dependency gate we
confirmed this by removing the gate and watching the new tests fail
(`MUTATION_KILLED`), rather than trusting that a green suite means the code is
exercised. `/tmp/mutation-check.sh` in that session was the harness; recreate it
if you want to re-run that check.