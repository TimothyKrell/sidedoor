-- Preparing is no longer a stage: an application keeps its stage while its AI prep task runs, and
-- the pipeline shows that task on the card. One still marked Preparing goes back to Interested, or
-- to Ready for review if it already has a package (it was being revised).
UPDATE `applications` SET `stage` = CASE WHEN `package_md` IS NOT NULL AND `package_md` <> '' THEN 'review' ELSE 'interested' END WHERE `stage` = 'preparing';
