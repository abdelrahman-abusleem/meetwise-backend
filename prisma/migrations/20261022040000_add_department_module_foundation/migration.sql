BEGIN;
CREATE TYPE "DepartmentKind" AS ENUM ('TECH', 'SALES');
CREATE TYPE "DepartmentStatus" AS ENUM ('DISABLED', 'ACTIVE');
CREATE TABLE "departments" (
 "id" UUID NOT NULL,
 "kind" "DepartmentKind" NOT NULL,
 "status" "DepartmentStatus" NOT NULL DEFAULT 'DISABLED',
 "version" INTEGER NOT NULL DEFAULT 0 CHECK ("version" >= 0),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "departments_kind_key" ON "departments"("kind");
CREATE TABLE "department_activation_events" (
 "id" UUID NOT NULL,
 "department_id" UUID NOT NULL,
 "actor_id" UUID NOT NULL,
 "from_status" "DepartmentStatus",
 "to_status" "DepartmentStatus" NOT NULL,
 "version" INTEGER NOT NULL CHECK ("version" > 0),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "department_activation_events_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "department_activation_events_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "department_activation_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "department_activation_events_department_id_version_key" ON "department_activation_events"("department_id", "version");
COMMIT;
