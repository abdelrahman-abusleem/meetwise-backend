-- Additive only: existing installation state and historical users/License rows are preserved.
ALTER TABLE "system_settings"
  ADD COLUMN "bootstrap_token_hash" TEXT,
  ADD COLUMN "bootstrap_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "bootstrap_consumed_at" TIMESTAMPTZ(3);
