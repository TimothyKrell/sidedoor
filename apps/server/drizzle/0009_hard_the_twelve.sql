ALTER TABLE `applications` ADD `posted_at` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `posted_at_source` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `posted_at_exact` integer;--> statement-breakpoint
ALTER TABLE `applications` ADD `listing_status` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `listing_checked_at` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `listing_evidence` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `listing_misses` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` ADD `listing_closed_at` text;