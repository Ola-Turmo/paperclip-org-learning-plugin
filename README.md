# uos-org-learning-plugin

Organizational learning plugin for Paperclip — captures, indexes, and surfaces learnings across the UOS Paperclip ecosystem.

## What it does

- Ingests learnings from incidents, projects, departments, and connectors
- Provides a searchable learning corpus with tagging and categorization
- Surfaces relevant learnings at decision and review points
- Maintains a learning health dashboard

## Development

```bash
# Install dependencies
npm install --legacy-peer-deps

# Type-check
npm run plugin:typecheck

# Build
npm run plugin:build

# Run tests
npm run plugin:test

# Watch mode (worker + ui)
npm run plugin:dev
```

## Architecture

- `src/manifest.ts` — Plugin manifest (capabilities, UI slots, entrypoints)
- `src/types.ts` — Core entity interfaces (Learnings, Sources, Tags)
- `src/constants.ts` — Plugin ID, DATA_KEYS, ACTION_KEYS, TOOL_KEYS
- `src/helpers.ts` — Data access layer (in-memory store + query helpers)
- `src/worker.ts` — Handler registration (data queries, actions, tools)
- `src/ui/index.tsx` — React UI widgets (dashboard, learning feed)
