# TypeScript Strictness Reference

Strictness flags and fix patterns captured from enabling maximum TypeScript strictness in the OpenMuse monorepo.

See SKILL.md for the summary; this file is the detailed reference.

## Essential Compiler Flags (tsconfig.json)

```json
{
  "strict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "noErrorTruncation": true,
  "allowUnreachableCode": false,
  "allowUnusedLabels": false
}
```

### Flags to AVOID (or handle with care)

| Flag | Problem |
|------|---------|
| `strictBlockScope` | Not a valid TS compiler option; causes TS5023 |
| `noPropertyAccessFromIndexSignature` | 273 false positives from `process.env.XXX`; noise drowns signal |
| `strictFunctionTypes` | Already implied by `strict: true` |

## Fix Patterns for `noUncheckedIndexedAccess`

### 1. Index access before property
```typescript
arr[0].prop        // TS2532: arr[0] is T | undefined
arr[0]!.prop       // OK: assertion at index site
```

### 2. Array destructuring → indexed access
```typescript
const [mail] = await client.listMail();        // Before
const mail = (await client.listMail())[0]!;      // After
```

### 3. Compound assignment
```typescript
bytes[0] ^= 1;                          // Before — ! invalid in compound assignment
bytes[0] = (bytes[0]! ^ 1);              // After — parenthesize the whole RHS
```

### 4. Multi-value destructuring
```typescript
const [a, b] = arr;          // Before
const a = arr[0]!;
const b = arr[1]!;           // After
```

### 5. `let` variable declarations (noEvolvingTypes)
```typescript
const saved = [];            // Before — evolves to any[]
const saved: Artifact[] = []; // After — explicit type
```

### 6. Test callback parameters
```typescript
test("name", async (t) => { ... });  // Before — 't' unused, TS6133
test("name", async () => { ... });    // After
```

## Per-Project tsconfig

Each sub-project needs its own tsconfig with the same strictness flags:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    // ... all other flags
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

The root `pnpm typecheck` should verify all tsconfigs:
```json
{
  "typecheck": "tsc --noEmit && pnpm --dir apps/mobile typecheck && tsc --noEmit -p apps/worker/tsconfig.json"
}
```