# Development and testing

## Environment

The verified toolchain is Node.js 24.21.0, NestJS 11, TypeScript 5.9.3 and Prisma 7.10.1. Use the checked-in lockfile for exact package versions. Install with `npm ci --ignore-scripts`; package-native setup and client generation may be required in a clean environment. They were not rerun for this source publication.

`.env.example` contains placeholders only. Runtime configuration includes DATABASE_URL, Redis host/port, three independent signing/reset secrets, password-reset TTL, frontend origin and SMTP settings. SMTP configuration is not proof of live delivery. A configured database, a compatible generated Prisma client and Redis are required before starting the full applications.

## Commands

| Command                                                    | Purpose                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run test:meetings`                                    | Pure domain/application, recording SQL and controlled composition tests.    |
| `npm test -- --runInBand --no-cache`                       | Jest unit tests.                                                            |
| `npm run test:security`                                    | Defensive dependency and parser regressions using local synthetic fixtures. |
| `npm run typecheck`                                        | API, worker, security, bootstrap and recovery compiler checks.              |
| Other `typecheck:*` scripts                                | Strict feature-specific compiler projects.                                  |
| `npm run lint`                                             | Non-mutating TypeScript lint.                                               |
| `npm run schema:validate:offline`                          | Local Prisma schema validation without a datasource or generation.          |
| `npm run build`                                            | API, worker, bootstrap and recovery builds.                                 |
| `node --test test/infrastructure/*.test.cjs`               | Contract-validator and workflow safety checks.                              |
| `node scripts/validate_openapi.cjs contracts/openapi.yaml` | Local Node OpenAPI validation.                                              |

Builds should use an isolated output workspace when preserving existing artifacts. Generated Prisma files and dependencies are local prerequisites and must not be committed.

## Infrastructure-dependent checks

`npm run test:integration` uses disposable Redis/security fixtures; `npm run test:e2e` prepares disposable PostgreSQL/Redis and HTTP fixtures. Do not run either without identifying and authorizing the exact disposable target. Migration execution, seeding and client generation were not performed for this publication. Empty/nonempty migration, rollback, race and restore behavior need later verification on a permitted target.

The checked-in Compose/Dockerfiles are development scaffolding, not a verified deployment. Do not start them as an offline validation shortcut.

## Source-only branch automation

The publication branch is excluded by an exact push-branch filter. Every job also rejects that branch/ref and pull-request head. Its commit carries `[skip ci]` as an additional supported push/PR safeguard. No hosted infrastructure workflow is authorized or claimed as passed. Main configuration and branch protections are unchanged.

## Migration integrity and source directives

Historical SQL migrations are retained byte-for-byte, including their comments, to preserve migration checksums. Ordinary application/test comments are removed; required compiler directives and executable shebangs remain. String literals, regular expressions and synthetic fixture content retain their original meaning.
