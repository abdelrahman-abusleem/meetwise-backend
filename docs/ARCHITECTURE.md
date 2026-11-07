# Backend architecture

## Applications

The API registers setup, authentication, settings, department memberships, meeting features and health infrastructure. The worker entry point has its existing system/auth processors. Bootstrap and recovery are separate command-line applications.

## Dependency boundaries

Domain policies describe legal transitions and eligibility. Application services coordinate repositories and provider ports. Infrastructure implements SQL, queue publication, email transport and local storage. NestJS factories compose explicit dependencies where interfaces have no runtime token.

Many capture, analysis, review, execution and export classes remain library/application components. Their presence does not mean a root worker consumer or public route has been registered. Opt-in export and notification composition requires explicit supplied ports; it has no production in-memory fallback.

## Identity and authorization

System roles are OWNER, MANAGER and MEMBER. Department roles and meeting assignments have separate scope. Private-content access, metadata administration, review, approval and external execution are distinct purposes. Neither a creator foreign key nor an administrative role is a general export grant.

## Persistence and concurrency

Prepared PostgreSQL constraints bind transcript sessions, exact transcript revisions, item evidence and export creators. Historical migration sources are immutable. Source validation and recording SQL doubles cannot establish actual foreign-key, unique-index, locking, isolation or crash durability behavior.

Outbox publication happens after a short database claim transaction. Publication and marking are not one distributed transaction; retries and duplicate deliveries are expected. Attempt identities, lease ownership, state/version CAS and unknown-effect reconciliation must be enforced by durable adapters.

## Untrusted content

Transcript and model output do not carry tools or credentials. Evidence must resolve to the exact source snapshot and be verified before approval. Human authorization and immutable approved payloads precede outgoing actions. Protected references are storage bindings, not access credentials.

## External boundaries

Actual database/queue bindings, provider admission and consent, private key custody, approved export expiry and retention configuration need separate operational verification. This branch enables none of those operations.
