# MeetWise Backend

MeetWise is a self-hosted meeting-to-action backend for a single organization. It brings meeting records, transcript provenance, structured analysis, human review and destination-specific actions into one scoped workflow.

**Current status: reviewed backend source with offline validation.** This branch is a source-only publication, not a deployment or a completed end-to-end product. Database, Redis, email, live meeting capture and provider integrations have not been verified for this published snapshot.

## What it solves

Meeting notes lose context when they become tasks or sales follow-ups. MeetWise keeps source evidence, revision history and approval boundaries attached to proposed actions. Transcript and model output remain untrusted; administrative access does not automatically grant private-content access or permission to execute an external action.

## Implemented source capabilities

| Area                    | Source scope                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and identity      | First-owner bootstrap, license-independent setup, canonical system and department roles, scoped memberships and configuration boundaries.                                                 |
| Authentication          | Per-device refresh-session families, token rotation, replay revocation, logout, password-reset protections and a separate owner-recovery CLI.                                             |
| Meetings                | Scoped creation, metadata access, cancellation and lifecycle policies, assignment and transfer rules.                                                                                     |
| Capture and evidence    | Scheduling/capture policies, encrypted transcript envelopes, revision membership, ingestion receipts and evidence-source constraints.                                                     |
| Analysis and review     | Analysis-run state and repair limits, item review/approval policies and prepared item/evidence persistence sources.                                                                       |
| Asynchronous processing | Outbox and notification repositories, delivery/recovery policies, queue-facing adapters and controlled composition tests.                                                                 |
| External actions        | Destination-scoped execution identities, attempt/lease fencing and unknown-effect reconciliation policies.                                                                                |
| Export                  | JSON/CSV rendering, private local-object storage, export request/download-audit schema sources and settled-state guards. Full source selection and authorization bindings remain pending. |

These capabilities have different integration depths. Much of the meeting-to-action pipeline is library/application source rather than registered API routes or active worker consumers. See [implementation status](docs/STATUS.md).

## Technology

- Node.js 24 and TypeScript 5.9.
- NestJS 11 API, worker and command-line applications.
- Prisma 7.10.1 with PostgreSQL schema and migration sources.
- BullMQ 5 and ioredis for queue infrastructure.
- Cookie-based JWT authentication, Argon2 password hashing and validated DTOs.
- Nodemailer transport source, with real delivery unverified.
- Jest, Node's test runner and Python offline tooling.

The lockfile is authoritative for dependency versions. No paid provider or hosted service is required to inspect the code or run the pure offline test suites.

## Architecture

HTTP controllers handle transport concerns; application services coordinate use cases; domain policies hold state and authorization invariants. Infrastructure adapters implement persistence, queue, storage and provider boundaries through explicit contracts.

PostgreSQL is the intended source of truth. Outbox publication and queue delivery are at least once, so consumers need durable receipts and reconciliation. Provider calls must stay outside short database transactions. See [architecture](docs/ARCHITECTURE.md).

```text
apps/api/          HTTP API and feature modules
apps/worker/       Worker entry point and processors
apps/bootstrap/    First-owner bootstrap CLI
apps/recovery/     Owner-recovery CLI
libs/meetings/     Meeting, transcript, analysis, notification and export logic
libs/external-actions/  Execution policies and application services
libs/security/     Shared security controls
libs/infrastructure/  Configuration, database, Redis, health and queue support
prisma/            Schema and immutable migration sources
contracts/         Proposed and implemented API contract sections
test/              Offline, security, integration and E2E test infrastructure
scripts/           Contract validation and transcription-quality utilities
```

## Local development

Use Node.js 24 and npm. PostgreSQL and Redis are required for an actual API/worker runtime. Python 3 is needed for the optional contract and transcription-quality tools.

```bash
git clone https://github.com/abdelrahman-abusleem/meetwise-backend.git
cd meetwise-backend
git checkout codex/source-publication-20261104
npm ci --ignore-scripts
```

The installation command matches the repository workflow; a fresh dependency installation was not performed for this publication. Native dependencies may require platform-specific setup.

Copy `.env.example` to a private local `.env` and replace every placeholder. Use separate random access-token, refresh-token and password-reset secrets. Never commit credentials, private keys or database dumps.

Prisma uses `prisma.config.ts` for its datasource configuration. Generated client files are intentionally untracked. The publication checks used an existing local client; clean-clone client generation and database initialization remain prerequisites for runtime development and were not executed here. Do not apply migration sources blindly to an existing installation.

After those runtime prerequisites are prepared in an authorized environment:

```bash
npm run start:dev
npm run start:worker:dev
```

First-owner setup and owner recovery have separate CLI entry points, `npm run setup:token` and `npm run owner:recovery`. They require their built applications, configured database and explicit operator authorization; they are not offline smoke commands.

## Offline validation

```bash
npm run test:meetings
npm test -- --runInBand --no-cache
npm run test:security
npm run typecheck
npm run lint
npm run schema:validate:offline
npm run build
```

Additional strict feature typechecks are listed in `package.json`. Builds require an available compatible generated client. The schema-validation command uses a separate configuration without a datasource, environment loading or generation hooks.

`npm run test:integration` and `npm run test:e2e` require explicitly prepared disposable infrastructure. They are not part of the source-only publication run and must not target production or shared data. See [development and testing](docs/DEVELOPMENT.md).

## API documentation

The API configures Swagger UI at `/docs` and its document at `/docs-json` outside production mode. An actual running, configured API is required. `contracts/openapi.yaml` also contains proposed sections; a documented path is not proof that the complete feature is registered or operational.

## Limitations and publication policy

- No current database-backed or end-to-end runtime verification is claimed.
- Migration SQL is prepared source, not evidence of applied migrations.
- Live meeting capture, transcription quality, real email and external-provider actions remain unverified or gated.
- Export source selection, current content-purpose authorization, expiry configuration and final download bindings are incomplete.
- Complete API/worker composition, recovery validation and retention policies remain outstanding.
- Hosted CI is deliberately excluded on this source-publication branch. Skipped CI is not passed CI; main and its protections are unchanged.

See [remaining work](docs/STATUS.md) for the source/runtime distinction.

## License

No repository license file is included, and `package.json` is marked `UNLICENSED`. This snapshot does not claim an open-source license grant.
