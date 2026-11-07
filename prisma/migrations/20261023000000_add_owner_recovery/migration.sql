-- Additive only: historical user, License, bootstrap and session records are preserved.
CREATE TABLE "owner_recovery_tokens" (
 "user_id" UUID NOT NULL PRIMARY KEY, "digest" TEXT NOT NULL,
 "token_version" INTEGER NOT NULL CHECK ("token_version" >= 0),
 "expires_at" TIMESTAMPTZ(3) NOT NULL, "consumed_at" TIMESTAMPTZ(3),
 "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "owner_recovery_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "owner_recovery_digest_shape" CHECK ("digest" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE "owner_recovery_events" (
 "id" UUID NOT NULL PRIMARY KEY, "user_id" UUID NOT NULL,
 "action" TEXT NOT NULL CHECK ("action" IN ('ISSUED', 'CONSUMED')),
 "token_version" INTEGER NOT NULL CHECK ("token_version" >= 0),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "owner_recovery_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "owner_recovery_events_user_id_idx" ON "owner_recovery_events"("user_id");
