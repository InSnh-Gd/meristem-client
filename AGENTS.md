# Meristem Client Agent Guide

## Scope
- This guide applies only to `meristem-client/`.
- Keep behavior aligned with root `AGENTS.md`.

## Runtime and Commands
- Bun-only commands:
  - `bun run build`
  - `bun run dev`
  - `bun run start` (legacy script path may invoke Node internally; avoid unless strictly necessary and approved)
  - direct runtime preferred: `bun dist/index.js` after build
- Do not use `npm`/`yarn`/`pnpm` commands.

## Engineering Constraints
- Do not use Node.js runtime flows unless strictly necessary and explicitly approved.
- No `any`; use `unknown` + type guards.
- Keep TypeScript strict semantics; do not weaken strict checks.
- Avoid OOP/Java-style implementation; prefer FP/composition.
- Preserve client service flow in composable functional style.
- Run LSP/type diagnostics after TypeScript edits.
- For uncertain external facts, use search MCP and cite evidence.

## Client Role and Boundaries
- `meristem-client` is the unified node binary for `AGENT` and `GIG`.
- Keep join/bootstrap interaction in client; do not move Core orchestration logic here.
- Keep persona naming canonical (`AGENT` / `GIG` only).

## Current Behavior Baseline
- Entry orchestrates: join -> NATS connect -> heartbeat/pulse start -> graceful shutdown.
- Join endpoint: `POST /api/v1/join` via `MERISTEM_CORE_URL` (default `http://localhost:3000`).
- Heartbeat publish subject: `meristem.v1.hb.[node_id]`.
- Pulse publish subject (current code): `meristem.v1.sys.pulse`.
- Credentials persisted under `.meristem/credentials.json` unless overridden.

## Environment Variables
- `MERISTEM_CORE_URL`
- `MERISTEM_NODE_ID`
- `MERISTEM_CLAIMED_IP`
- `MERISTEM_CREDENTIALS_PATH`
- `MERISTEM_CONFIG_PATH`
- `MERISTEM_HOSTNAME`
- `MERISTEM_IDENTITY_PERSONA`

## Key Files
- Entry: `src/index.ts`
- Identity/Join: `src/services/identity.ts`
- Heartbeat: `src/services/heartbeat.ts`
- Pulse: `src/services/pulse.ts`
- Result inbox: `src/services/result-inbox.ts`
- NATS connection: `src/nats/connection.ts`
- Logger: `src/utils/logger.ts`

## Validation
- Preferred full test run from project root: `bun test`.
- Package-local tests: `bun test meristem-client/src/__tests__`.
- Keep event payloads and subjects aligned with docs (`docs/standards/EVENT_BUS_SPEC.md`, `docs/standards/HARDWARE_PROTOCOL.md`).
