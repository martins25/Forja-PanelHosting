-- Track which admin reviewed a removal request and when.
ALTER TABLE `removal_requests` ADD COLUMN `reviewed_by` integer REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `removal_requests` ADD COLUMN `reviewed_at` text;
