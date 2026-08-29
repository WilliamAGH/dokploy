ALTER TABLE "application" DROP COLUMN IF EXISTS "readinessCheckSwarm";--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "swarmVipConnectionReuse" boolean DEFAULT true NOT NULL;
