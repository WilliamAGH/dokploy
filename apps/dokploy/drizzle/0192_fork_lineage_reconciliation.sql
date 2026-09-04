-- Existing fork databases recorded the former fork migration after upstream's
-- 0191 timestamp, so they skip the newly merged upstream entry. Reapply both
-- histories idempotently before retaining the fork-only application setting.
ALTER TABLE "network" ADD COLUMN IF NOT EXISTS "dockerId" text;--> statement-breakpoint
UPDATE "organization_role" AS r
SET "permission" = jsonb_set(
	r."permission"::jsonb,
	'{server}',
	(r."permission"::jsonb->'server') || '["terminal"]'::jsonb
)::text
WHERE jsonb_typeof(r."permission"::jsonb->'server') = 'array'
AND r."permission"::jsonb->'server' @> '["read"]'::jsonb
AND NOT r."permission"::jsonb->'server' @> '["terminal"]'::jsonb;--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "readinessCheckSwarm";--> statement-breakpoint
ALTER TYPE "public"."DnsProviderType" ADD VALUE IF NOT EXISTS 'infomaniak';--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "swarmVipConnectionReuse" boolean DEFAULT true NOT NULL;
