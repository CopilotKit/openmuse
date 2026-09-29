# noUncheckedIndexedAccess Fix Patterns

When `noUncheckedIndexedAccess` is enabled, every array index returns `T | undefined`.

## 1. Index access before property (production + tests)

```typescript
arr[0].prop        // TS2532: arr[0] is T | undefined
arr[0]!.prop       // OK: assertion at index site
```

### Bulk-fix for simple cases

```bash
# Adds ! after [N] before .  (misses expressions in parens like (await f())[0].x)
sed -i -E 's/([a-zA-Z_][a-zA-Z0-9_]*)\[([0-9]+)\]\./\1[\2]!./g' file.ts
# Adds ! after [N] before ; , )  (catches end-of-line cases)
sed -i -E 's/([a-zA-Z_][a-zA-Z0-9_]*)\[([0-9]+)\]([;,\)])/\1[\2]!\3/g' file.ts
```

### Manual fix for parenthesized expressions

```typescript
(await f())[0].prop   // sed misses this — fix manually
(await f())[0]!.prop   // correct
```

## 2. Array destructuring (tests only)

Cannot add `!` to a destructuring pattern. Convert to indexed access:

```typescript
const [mail] = await client.listMail();        // Before
const mail = (await client.listMail())[0]!;      // After
const [a, b] = arr;                               // Before (multi)
const a = arr[0]!; const b = arr[1]!;               // After
```

## 3. .find() results

```typescript
const found = arr.find(x => x.id === target)!;   // Assert when guaranteed by invariant
```
For production code: return early if not found rather than asserting.
For tests: assert since the data is controlled by setup.

## 4. Compound assignment

Cannot use `!` in a compound assignment (`bytes[0]! ^= 1` is a syntax error).
Split into a separate assignment with parentheses:

```typescript
bytes[0] ^= 1;                          // Before — TS18048: bytes[0] is possibly undefined
bytes[0] = (bytes[0]! ^ 1);            // After — assert with ! inside parens
```

## 5. Multi-step fix strategy

1. Run sed for bulk `[0].prop` → `[0]!.prop` on test files.
2. Run `npx tsc --noEmit` and check remaining errors.
3. Fix destructuring sites — search backward for `const varname =`.
4. Fix parenthesized expressions like `(await f())[0]` manually.
5. Fix unused parameters (remove `(t)` from `node:test` callbacks).
6. Re-run `npx tsc --noEmit` to confirm zero errors.