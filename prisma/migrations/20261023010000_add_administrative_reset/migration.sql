ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "administrative_reset_tokens" (
  "user_id" UUID PRIMARY KEY REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "issuer_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "target_role" "SystemRole" NOT NULL CHECK ("target_role" IN ('MANAGER', 'MEMBER')),
  "token_version" INTEGER NOT NULL CHECK ("token_version" >= 0),
  "issuer_token_version" INTEGER NOT NULL CHECK ("issuer_token_version" >= 0),
  "digest" TEXT NOT NULL CHECK ("digest" ~ '^[a-f0-9]{64}$'),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "administrative_reset_tokens_issuer_id_idx" ON "administrative_reset_tokens"("issuer_id");
CREATE TABLE "administrative_reset_events" (
  "id" UUID PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "issuer_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "token_version" INTEGER NOT NULL CHECK ("token_version" >= 0),
  "action" TEXT NOT NULL CHECK ("action" IN ('ISSUED', 'CONSUMED')),
  "request_hash" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("action" = 'ISSUED' AND "request_hash" ~ '^[a-f0-9]{64}$' AND "request_hash" IS NOT NULL)
      OR ("action" = 'CONSUMED' AND "request_hash" IS NULL))
);
CREATE UNIQUE INDEX "admin_reset_event_once" ON "administrative_reset_events"("user_id", "token_version", "action");
CREATE UNIQUE INDEX "admin_reset_request_once" ON "administrative_reset_events"("issuer_id", "user_id", "request_hash");
CREATE INDEX "administrative_reset_events_issuer_id_idx" ON "administrative_reset_events"("issuer_id");
