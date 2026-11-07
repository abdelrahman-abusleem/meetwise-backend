CREATE TABLE "setup_drafts" (
  "id" UUID NOT NULL, "actor_id" UUID NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "data" JSONB NOT NULL, "base_settings" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_activity_at" TIMESTAMPTZ(3) NOT NULL, "expires_at" TIMESTAMPTZ(3) NOT NULL, "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "setup_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "setup_draft_positive_version" CHECK ("version">0),
  CONSTRAINT "setup_draft_lifetime" CHECK ("last_activity_at">="created_at" AND "expires_at">"last_activity_at" AND "expires_at"<="created_at"+INTERVAL '7 days' AND "expires_at"<="last_activity_at"+INTERVAL '24 hours'),
  CONSTRAINT "setup_drafts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "setup_drafts_actor_id_expires_at_idx" ON "setup_drafts"("actor_id","expires_at");
CREATE TABLE "setup_draft_events" (
  "id" UUID NOT NULL, "draft_id" UUID NOT NULL, "actor_id" UUID NOT NULL, "version" INTEGER NOT NULL,
  "action" TEXT NOT NULL, "request_hash" TEXT NOT NULL, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "setup_draft_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "setup_draft_event_positive_version" CHECK ("version">0),
  CONSTRAINT "setup_draft_event_action" CHECK ("action" IN ('CREATED','UPDATED','ACTIVATED')),
  CONSTRAINT "setup_draft_events_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "setup_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "setup_draft_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "setup_draft_events_draft_id_version_key" ON "setup_draft_events"("draft_id","version");
CREATE UNIQUE INDEX "setup_draft_events_actor_id_request_hash_key" ON "setup_draft_events"("actor_id","request_hash");
