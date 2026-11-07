-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "LicenseEdition" AS ENUM ('TRIAL', 'STANDARD', 'PRO', 'ENTERPRISE');

-- AlterTable system_settings: add singleton_key, default company_name
ALTER TABLE "system_settings" ADD COLUMN "singleton_key" TEXT NOT NULL DEFAULT 'system';
ALTER TABLE "system_settings" ALTER COLUMN "company_name" SET DEFAULT 'Meetwise';

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_singleton_key_key" ON "system_settings"("singleton_key");

-- CreateTable licenses
CREATE TABLE "licenses" (
    "id" UUID NOT NULL,
    "singleton_key" TEXT NOT NULL,
    "license_key_hash" TEXT,
    "customer_name" TEXT NOT NULL,
    "installation_id" UUID NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "edition" "LicenseEdition" NOT NULL,
    "issued_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "updates_expires_at" TIMESTAMP(3),
    "support_expires_at" TIMESTAMP(3),
    "enabled_features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "license_payload" JSONB,
    "signature" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable users
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "refresh_token_hash" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "licenses_singleton_key_key" ON "licenses"("singleton_key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
