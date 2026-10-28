-- Live updates: every write to these tables bumps a per-table counter, whatever code path made it.
-- The server polls this tiny table and tells open pages what changed (src/live.ts).
CREATE TABLE `change_counters` (
	`tbl` text PRIMARY KEY NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('companies');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('sources');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('postings');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('applications');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('people');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('application_people');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('interactions');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('drafts');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('research');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('tasks');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('activity');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('notifications');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('chat_threads');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('chat_messages');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('settings');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('documents');
--> statement-breakpoint
INSERT INTO `change_counters` (`tbl`) VALUES ('resumes');
--> statement-breakpoint
CREATE TRIGGER `companies_insert_changed` AFTER INSERT ON `companies` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'companies'; END;
--> statement-breakpoint
CREATE TRIGGER `companies_update_changed` AFTER UPDATE ON `companies` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'companies'; END;
--> statement-breakpoint
CREATE TRIGGER `companies_delete_changed` AFTER DELETE ON `companies` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'companies'; END;
--> statement-breakpoint
CREATE TRIGGER `sources_insert_changed` AFTER INSERT ON `sources` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'sources'; END;
--> statement-breakpoint
CREATE TRIGGER `sources_update_changed` AFTER UPDATE ON `sources` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'sources'; END;
--> statement-breakpoint
CREATE TRIGGER `sources_delete_changed` AFTER DELETE ON `sources` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'sources'; END;
--> statement-breakpoint
CREATE TRIGGER `postings_insert_changed` AFTER INSERT ON `postings` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'postings'; END;
--> statement-breakpoint
CREATE TRIGGER `postings_update_changed` AFTER UPDATE ON `postings` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'postings'; END;
--> statement-breakpoint
CREATE TRIGGER `postings_delete_changed` AFTER DELETE ON `postings` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'postings'; END;
--> statement-breakpoint
CREATE TRIGGER `applications_insert_changed` AFTER INSERT ON `applications` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'applications'; END;
--> statement-breakpoint
CREATE TRIGGER `applications_update_changed` AFTER UPDATE ON `applications` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'applications'; END;
--> statement-breakpoint
CREATE TRIGGER `applications_delete_changed` AFTER DELETE ON `applications` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'applications'; END;
--> statement-breakpoint
CREATE TRIGGER `people_insert_changed` AFTER INSERT ON `people` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'people'; END;
--> statement-breakpoint
CREATE TRIGGER `people_update_changed` AFTER UPDATE ON `people` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'people'; END;
--> statement-breakpoint
CREATE TRIGGER `people_delete_changed` AFTER DELETE ON `people` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'people'; END;
--> statement-breakpoint
CREATE TRIGGER `application_people_insert_changed` AFTER INSERT ON `application_people` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'application_people'; END;
--> statement-breakpoint
CREATE TRIGGER `application_people_update_changed` AFTER UPDATE ON `application_people` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'application_people'; END;
--> statement-breakpoint
CREATE TRIGGER `application_people_delete_changed` AFTER DELETE ON `application_people` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'application_people'; END;
--> statement-breakpoint
CREATE TRIGGER `interactions_insert_changed` AFTER INSERT ON `interactions` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'interactions'; END;
--> statement-breakpoint
CREATE TRIGGER `interactions_update_changed` AFTER UPDATE ON `interactions` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'interactions'; END;
--> statement-breakpoint
CREATE TRIGGER `interactions_delete_changed` AFTER DELETE ON `interactions` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'interactions'; END;
--> statement-breakpoint
CREATE TRIGGER `drafts_insert_changed` AFTER INSERT ON `drafts` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'drafts'; END;
--> statement-breakpoint
CREATE TRIGGER `drafts_update_changed` AFTER UPDATE ON `drafts` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'drafts'; END;
--> statement-breakpoint
CREATE TRIGGER `drafts_delete_changed` AFTER DELETE ON `drafts` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'drafts'; END;
--> statement-breakpoint
CREATE TRIGGER `research_insert_changed` AFTER INSERT ON `research` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'research'; END;
--> statement-breakpoint
CREATE TRIGGER `research_update_changed` AFTER UPDATE ON `research` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'research'; END;
--> statement-breakpoint
CREATE TRIGGER `research_delete_changed` AFTER DELETE ON `research` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'research'; END;
--> statement-breakpoint
CREATE TRIGGER `tasks_insert_changed` AFTER INSERT ON `tasks` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'tasks'; END;
--> statement-breakpoint
CREATE TRIGGER `tasks_update_changed` AFTER UPDATE ON `tasks` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'tasks'; END;
--> statement-breakpoint
CREATE TRIGGER `tasks_delete_changed` AFTER DELETE ON `tasks` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'tasks'; END;
--> statement-breakpoint
CREATE TRIGGER `activity_insert_changed` AFTER INSERT ON `activity` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'activity'; END;
--> statement-breakpoint
CREATE TRIGGER `activity_update_changed` AFTER UPDATE ON `activity` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'activity'; END;
--> statement-breakpoint
CREATE TRIGGER `activity_delete_changed` AFTER DELETE ON `activity` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'activity'; END;
--> statement-breakpoint
CREATE TRIGGER `notifications_insert_changed` AFTER INSERT ON `notifications` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'notifications'; END;
--> statement-breakpoint
CREATE TRIGGER `notifications_update_changed` AFTER UPDATE ON `notifications` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'notifications'; END;
--> statement-breakpoint
CREATE TRIGGER `notifications_delete_changed` AFTER DELETE ON `notifications` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'notifications'; END;
--> statement-breakpoint
CREATE TRIGGER `chat_threads_insert_changed` AFTER INSERT ON `chat_threads` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'chat_threads'; END;
--> statement-breakpoint
CREATE TRIGGER `chat_threads_update_changed` AFTER UPDATE ON `chat_threads` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'chat_threads'; END;
--> statement-breakpoint
CREATE TRIGGER `chat_threads_delete_changed` AFTER DELETE ON `chat_threads` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'chat_threads'; END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_insert_changed` AFTER INSERT ON `chat_messages` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'chat_messages'; END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_update_changed` AFTER UPDATE ON `chat_messages` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'chat_messages'; END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_delete_changed` AFTER DELETE ON `chat_messages` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'chat_messages'; END;
--> statement-breakpoint
CREATE TRIGGER `settings_insert_changed` AFTER INSERT ON `settings` WHEN NEW.`key` NOT LIKE 'meta:%' BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'settings'; END;
--> statement-breakpoint
CREATE TRIGGER `settings_update_changed` AFTER UPDATE ON `settings` WHEN NEW.`key` NOT LIKE 'meta:%' BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'settings'; END;
--> statement-breakpoint
CREATE TRIGGER `settings_delete_changed` AFTER DELETE ON `settings` WHEN OLD.`key` NOT LIKE 'meta:%' BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'settings'; END;
--> statement-breakpoint
CREATE TRIGGER `documents_insert_changed` AFTER INSERT ON `documents` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'documents'; END;
--> statement-breakpoint
CREATE TRIGGER `documents_update_changed` AFTER UPDATE ON `documents` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'documents'; END;
--> statement-breakpoint
CREATE TRIGGER `documents_delete_changed` AFTER DELETE ON `documents` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'documents'; END;
--> statement-breakpoint
CREATE TRIGGER `resumes_insert_changed` AFTER INSERT ON `resumes` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'resumes'; END;
--> statement-breakpoint
CREATE TRIGGER `resumes_update_changed` AFTER UPDATE ON `resumes` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'resumes'; END;
--> statement-breakpoint
CREATE TRIGGER `resumes_delete_changed` AFTER DELETE ON `resumes` BEGIN UPDATE `change_counters` SET `seq` = `seq` + 1 WHERE `tbl` = 'resumes'; END;
