CREATE INDEX `postings_source_seen` ON `postings` (`source_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `postings_decision` ON `postings` (`decision`);