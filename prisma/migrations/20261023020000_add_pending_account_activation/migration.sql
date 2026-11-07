CREATE TABLE "activation_tokens" (
  "user_id" UUID PRIMARY KEY REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "issuer_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "target_role" "SystemRole" NOT NULL CHECK ("target_role" IN ('MANAGER', 'MEMBER')),
  "token_version" INTEGER NOT NULL CHECK ("token_version" >= 0),
  "issuer_token_version" INTEGER NOT NULL CHECK ("issuer_token_version" >= 0),
  "digest" TEXT NOT NULL CHECK ("digest" ~ '^[a-f0-9]{64}$'),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "activation_tokens_issuer_id_idx" ON "activation_tokens"("issuer_id");
CREATE TABLE "activation_events" (
  "id" UUID PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "issuer_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "token_version" INTEGER NOT NULL CHECK ("token_version" >= 0),
  "action" TEXT NOT NULL CHECK ("action" IN ('ISSUED', 'CONSUMED', 'REVOKED')),
  "request_hash" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("action" = 'ISSUED' AND "request_hash" ~ '^[a-f0-9]{64}$' AND "request_hash" IS NOT NULL)
      OR ("action" IN ('CONSUMED', 'REVOKED') AND "request_hash" IS NULL))
);
CREATE UNIQUE INDEX "activation_event_once" ON "activation_events"("user_id", "token_version", "action");
CREATE UNIQUE INDEX "activation_request_once" ON "activation_events"("issuer_id", "request_hash");
CREATE INDEX "activation_events_issuer_id_idx" ON "activation_events"("issuer_id");
