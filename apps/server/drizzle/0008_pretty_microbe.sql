CREATE TABLE `stale_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text,
	`application_id` text,
	`section` text,
	`doc_key` text NOT NULL,
	`sentence` text NOT NULL,
	`fact` text NOT NULL,
	`suggestion` text,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`task_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`cleared_at` text
);
--> statement-breakpoint
CREATE INDEX `stale_flags_draft` ON `stale_flags` (`draft_id`);--> statement-breakpoint
CREATE INDEX `stale_flags_app` ON `stale_flags` (`application_id`);--> statement-breakpoint
CREATE INDEX `stale_flags_status` ON `stale_flags` (`status`);--> statement-breakpoint
-- Live updates for the new table (see 0001_live_changes).
INSERT INTO `change_counters` (`tbl`) VALUES ('stale_flags');--> statement-breakpoint
CREATE TRIGGER `stale_flags_insert_changed` AFTER INSERT ON `stale_flags` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'stale_flags'; END;--> statement-breakpoint
CREATE TRIGGER `stale_flags_update_changed` AFTER UPDATE ON `stale_flags` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'stale_flags'; END;--> statement-breakpoint
CREATE TRIGGER `stale_flags_delete_changed` AFTER DELETE ON `stale_flags` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'stale_flags'; END;
