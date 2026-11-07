CREATE TYPE "DepartmentRole" AS ENUM ('ADMIN','MEMBER');
CREATE TABLE "department_memberships" (
 "id" UUID PRIMARY KEY,
 "department_id" UUID NOT NULL REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "role" "DepartmentRole" NOT NULL,
 "can_create_meetings" BOOLEAN NOT NULL DEFAULT false,
 "can_manage_meetings" BOOLEAN NOT NULL DEFAULT false,
 "can_approve_meetings" BOOLEAN NOT NULL DEFAULT false,
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">=1),
 "revoked_at" TIMESTAMPTZ(3),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "department_memberships_department_id_user_id_key" ON "department_memberships"("department_id","user_id");
CREATE INDEX "department_memberships_user_id_idx" ON "department_memberships"("user_id");
CREATE TABLE "membership_events" (
 "id" UUID PRIMARY KEY,
 "department_id" UUID NOT NULL REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "actor_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "version" INTEGER NOT NULL CHECK ("version">=1),
 "action" TEXT NOT NULL CHECK ("action" IN ('GRANTED','UPDATED','REVOKED')),
 "request_hash" TEXT NOT NULL CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
 "snapshot" JSONB NOT NULL,
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "membership_events_department_id_user_id_version_key" ON "membership_events"("department_id","user_id","version");
CREATE UNIQUE INDEX "membership_events_actor_id_request_hash_key" ON "membership_events"("actor_id","request_hash");
CREATE INDEX "membership_events_user_id_idx" ON "membership_events"("user_id");
