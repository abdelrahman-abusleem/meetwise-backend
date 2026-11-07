BEGIN;

-- Current development has no legacy ADMIN users. Unexpected deployed records fail before role writes.
-- An actual nonempty ADMIN upgrade needs a separately OWNER-approved plan, never automatic promotion.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" WHERE "role"::text = 'ADMIN') THEN
    RAISE EXCEPTION 'Legacy ADMIN records require an explicit OWNER-approved upgrade plan; no automatic conversion';
  END IF;
END $$;

CREATE TYPE "SystemRole" AS ENUM ('OWNER', 'MANAGER', 'MEMBER');
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "SystemRole" USING "role"::text::"SystemRole";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
DROP TYPE "UserRole";

COMMIT;
