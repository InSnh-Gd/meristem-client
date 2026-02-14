# Meristem Client (Standalone Repository)

This repository can run as a standalone client checkout. It does not require cloning the full workspace on each client host.

## 1) Runtime Requirements

- Bun `>= 1.0.0`
- Network access to Core HTTP (`MERISTEM_CORE_URL`) and NATS (`MERISTEM_NATS_URL`)

## 2) Dependency Configuration

The client depends on these external packages:

- `@insnh-gd/meristem-shared` via JSR/npm alias in `package.json`
- `nats`
- `pino`
- `@elysiajs/eden`
- `@iarna/toml`

Install dependencies directly in this repository:

```bash
bun install
```

If a private registry/proxy is required in your environment, configure Bun registry access before `bun install`.

## 3) Minimal Standalone Startup

```bash
bun run build
MERISTEM_CORE_URL=http://<core-ip>:3000 \
MERISTEM_NATS_URL=nats://<core-ip>:4222 \
bun run src/index.ts
```

## 4) Multi-Client Deployment Pattern

For each client machine, use isolated local state paths:

```bash
MERISTEM_CORE_URL=http://<core-ip>:3000 \
MERISTEM_NATS_URL=nats://<core-ip>:4222 \
MERISTEM_HOSTNAME=mesh-client-<idx> \
MERISTEM_CONFIG_PATH=/var/lib/meristem/mesh-<idx>/config.json \
MERISTEM_CREDENTIALS_PATH=/var/lib/meristem/mesh-<idx>/credentials.json \
bun run src/index.ts
```

Each `idx` must be unique.
