BEGIN;
ALTER TABLE "system_settings" ADD COLUMN "bot_display_version" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "bot_display_changes" (
 "id" UUID NOT NULL, "settings_id" UUID NOT NULL, "actor_id" UUID NOT NULL,
 "version" INTEGER NOT NULL CHECK ("version" > 0),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "bot_display_changes_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "bot_display_changes_settings_id_fkey" FOREIGN KEY ("settings_id") REFERENCES "system_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "bot_display_changes_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "bot_display_changes_settings_id_version_key" ON "bot_display_changes"("settings_id", "version");
COMMIT;
