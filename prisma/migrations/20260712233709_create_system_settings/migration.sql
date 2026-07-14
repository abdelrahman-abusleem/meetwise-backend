-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL,
    "company_name" TEXT NOT NULL,
    "company_logo_url" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "default_language" TEXT NOT NULL DEFAULT 'en',
    "default_bot_name" TEXT NOT NULL DEFAULT 'Meetwise Bot',
    "recording_consent_required" BOOLEAN NOT NULL DEFAULT true,
    "retention_days" INTEGER NOT NULL DEFAULT 30,
    "auto_delete_transcripts" BOOLEAN NOT NULL DEFAULT false,
    "allow_audio_storage" BOOLEAN NOT NULL DEFAULT false,
    "setup_completed" BOOLEAN NOT NULL DEFAULT false,
    "setup_completed_at" TIMESTAMP(3),
    "product_version" TEXT NOT NULL DEFAULT '0.0.1',
    "installation_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_installation_id_key" ON "system_settings"("installation_id");
