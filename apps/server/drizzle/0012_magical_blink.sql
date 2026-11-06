CREATE TABLE `stage_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`stage` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stage_changes_app` ON `stage_changes` (`application_id`,`at`);
--> statement-breakpoint
-- The moves made before this table existed, from the activity log (setStage wrote each one there).
INSERT INTO `stage_changes` (`id`, `application_id`, `stage`, `at`)
SELECT 'stg_' || x.`id`, substr(x.`link`, 15),
  CASE
    WHEN x.`title` LIKE '%: Interested' THEN 'interested'
    WHEN x.`title` LIKE '%: Ready for review' THEN 'review'
    WHEN x.`title` LIKE '%: Approved to submit' THEN 'approved'
    WHEN x.`title` LIKE '%: Applied' THEN 'applied'
    WHEN x.`title` LIKE '%: Screening' THEN 'screening'
    WHEN x.`title` LIKE '%: Interviewing' THEN 'interviewing'
    WHEN x.`title` LIKE '%: Offer' THEN 'offer'
    ELSE 'closed'
  END,
  x.`at`
FROM `activity` x
WHERE x.`kind` = 'application' AND x.`link` LIKE '/applications/%'
  AND (x.`title` LIKE '%: Interested' OR x.`title` LIKE '%: Ready for review' OR x.`title` LIKE '%: Approved to submit' OR x.`title` LIKE '%: Applied'
    OR x.`title` LIKE '%: Screening' OR x.`title` LIKE '%: Interviewing' OR x.`title` LIKE '%: Offer' OR x.`title` LIKE '%: Closed');
