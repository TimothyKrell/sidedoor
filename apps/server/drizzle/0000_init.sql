CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`link` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_at` ON `activity` (`at`);--> statement-breakpoint
CREATE TABLE `application_people` (
	`application_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text,
	PRIMARY KEY(`application_id`, `person_id`)
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text,
	`company_id` text,
	`company_name` text NOT NULL,
	`role` text NOT NULL,
	`stage` text DEFAULT 'interested' NOT NULL,
	`status` text DEFAULT 'potential' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`source` text,
	`job_url` text,
	`apply_url` text,
	`location` text,
	`comp_text` text,
	`comp_min` integer,
	`comp_max` integer,
	`fit_score` integer,
	`next_action` text,
	`next_action_date` text,
	`applied_at` text,
	`last_activity_at` text,
	`package_md` text,
	`resume_id` text,
	`package_original_md` text,
	`editor_json` text,
	`match_json` text,
	`review_notes` text,
	`notes_md` text,
	`closed_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `applications_stage` ON `applications` (`stage`);--> statement-breakpoint
CREATE INDEX `applications_company` ON `applications` (`company_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`at` text NOT NULL,
	`page` text
);
--> statement-breakpoint
CREATE INDEX `chat_messages_thread` ON `chat_messages` (`thread_id`,`at`);--> statement-breakpoint
CREATE INDEX `chat_messages_page` ON `chat_messages` (`page`);--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`session_id` text,
	`provider` text,
	`model` text,
	`context` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`domain` text,
	`website` text,
	`description` text,
	`lanes` text DEFAULT '[]' NOT NULL,
	`interest` integer DEFAULT 0 NOT NULL,
	`funding_stage` text,
	`funding_amount` text,
	`funding_at` text,
	`funding_note` text,
	`funding_url` text,
	`ats_kind` text,
	`ats_board` text,
	`ats_checked_at` text,
	`email_pattern` text,
	`bad_email_patterns` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_slug` ON `companies` (`slug`);--> statement-breakpoint
CREATE TABLE `documents` (
	`key` text PRIMARY KEY NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`application_id` text,
	`channel` text DEFAULT 'email' NOT NULL,
	`to_email` text,
	`subject` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`author` text DEFAULT 'agent' NOT NULL,
	`original_body` text,
	`editor_changes` text,
	`edited_at` text,
	`editor_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`application_id` text,
	`channel` text DEFAULT 'email' NOT NULL,
	`direction` text DEFAULT 'out' NOT NULL,
	`summary` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interactions_person` ON `interactions` (`person_id`);--> statement-breakpoint
CREATE INDEX `interactions_app` ON `interactions` (`application_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`url` text,
	`priority` integer DEFAULT 3 NOT NULL,
	`dedupe_key` text,
	`ok` integer,
	`error` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`company_id` text,
	`company_name` text,
	`title` text,
	`kind` text DEFAULT 'other' NOT NULL,
	`email` text,
	`email_confidence` text,
	`email_source` text,
	`bounced_emails` text,
	`linkedin` text,
	`x` text,
	`phone` text,
	`stage` text DEFAULT 'not-contacted' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`last_contact_at` text,
	`next_contact_at` text,
	`cadence_days` integer,
	`next_action` text,
	`why_md` text,
	`notes_md` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `people_company` ON `people` (`company_id`);--> statement-breakpoint
CREATE INDEX `people_next` ON `people` (`next_contact_at`);--> statement-breakpoint
CREATE TABLE `postings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`source_id` text,
	`company_id` text,
	`company_name` text,
	`title` text NOT NULL,
	`location` text,
	`url` text,
	`apply_url` text,
	`posted_at` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`closed_at` text,
	`comp_text` text,
	`comp_min` integer,
	`comp_max` integer,
	`jd` text,
	`heuristic` text,
	`triage_status` text DEFAULT 'skipped' NOT NULL,
	`decision` text,
	`fit_score` integer,
	`lane` text,
	`summary` text,
	`reasons` text,
	`gaps` text,
	`location_fit` text,
	`location_note` text,
	`triaged_at` text,
	`user_status` text DEFAULT 'new' NOT NULL,
	`notified_at` text,
	`application_id` text,
	`via_url` text,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `postings_key` ON `postings` (`key`);--> statement-breakpoint
CREATE INDEX `postings_first_seen` ON `postings` (`first_seen_at`);--> statement-breakpoint
CREATE INDEX `postings_triage` ON `postings` (`triage_status`);--> statement-breakpoint
CREATE INDEX `postings_company` ON `postings` (`company_id`);--> statement-breakpoint
CREATE TABLE `research` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text,
	`company_id` text,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`task_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resume_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`resume_id` text NOT NULL,
	`content` text NOT NULL,
	`reason` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `resume_versions_resume` ON `resume_versions` (`resume_id`,`at`);--> statement-breakpoint
CREATE TABLE `resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'base' NOT NULL,
	`title` text NOT NULL,
	`application_id` text,
	`base_id` text,
	`theme` text DEFAULT 'classic' NOT NULL,
	`theme_options` text DEFAULT '{}' NOT NULL,
	`content` text NOT NULL,
	`review_base` text,
	`notes` text DEFAULT '[]' NOT NULL,
	`pdf_file` text,
	`pdf_pages` integer,
	`pdf_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `resumes_application` ON `resumes` (`application_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`board` text NOT NULL,
	`url` text,
	`company_id` text,
	`status` text DEFAULT 'candidate' NOT NULL,
	`tier` text DEFAULT 'normal' NOT NULL,
	`lanes` text DEFAULT '[]' NOT NULL,
	`why` text,
	`origin` text,
	`last_checked_at` text,
	`last_error` text,
	`last_job_count` integer,
	`matches_total` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_kind_board` ON `sources` (`kind`,`board`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`input` text DEFAULT '{}' NOT NULL,
	`output` text,
	`error` text,
	`log` text,
	`application_id` text,
	`posting_id` text,
	`person_id` text,
	`session_id` text,
	`provider` text,
	`model` text,
	`cost_usd` real,
	`run_after` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `tasks_status` ON `tasks` (`status`,`priority`);