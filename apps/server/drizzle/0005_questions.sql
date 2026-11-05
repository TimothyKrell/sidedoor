CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text,
	`scope` text DEFAULT 'application' NOT NULL,
	`about` text DEFAULT 'application' NOT NULL,
	`text` text NOT NULL,
	`key` text NOT NULL,
	`why` text,
	`options` text DEFAULT '[]' NOT NULL,
	`save_to` text,
	`asked_by` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`answer` text,
	`answered_at` text,
	`answered_by` text,
	`revised_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `questions_status` ON `questions` (`status`);--> statement-breakpoint
CREATE INDEX `questions_application` ON `questions` (`application_id`);--> statement-breakpoint
CREATE INDEX `questions_key` ON `questions` (`key`);--> statement-breakpoint
-- Live updates (see 0001_live_changes).
INSERT INTO `change_counters` (`tbl`) VALUES ('questions');
--> statement-breakpoint
CREATE TRIGGER `questions_insert_changed` AFTER INSERT ON `questions` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'questions'; END;
--> statement-breakpoint
CREATE TRIGGER `questions_update_changed` AFTER UPDATE ON `questions` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'questions'; END;
--> statement-breakpoint
CREATE TRIGGER `questions_delete_changed` AFTER DELETE ON `questions` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'questions'; END;
