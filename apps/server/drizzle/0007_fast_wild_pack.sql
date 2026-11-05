CREATE TABLE `document_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_key` text NOT NULL,
	`before` text,
	`after` text,
	`by` text NOT NULL,
	`reason` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `document_revisions_doc` ON `document_revisions` (`doc_key`,`at`);