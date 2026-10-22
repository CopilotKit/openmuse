# Domain docs

This repository uses a single domain context.

## Before exploring

- Read the root `CONTEXT.md` for shared vocabulary.
- Read relevant decisions in `docs/adr/`. An ADR marked superseded is historical context, not the current direction.

If a document is absent, continue without creating it solely to satisfy this reading rule. Add or update domain documentation when a term or decision actually changes.

## Language and decisions

Use the glossary's terms in issues, specs, implementation plans, and review comments. In particular, keep Bot, Channel, and Thread distinct; keep Reviewed action distinct from Policy approval. Avoid synonyms that `CONTEXT.md` explicitly rejects.

If proposed work conflicts with an accepted ADR, name the conflict and resolve it explicitly before treating the new direction as agreed.

## Layout

```text
/
├── CONTEXT.md
└── docs/
    └── adr/
```
