CREATE TABLE `certificates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL REFERENCES `sites`(`id`),
	`domain` text NOT NULL,
	`provider` text NOT NULL DEFAULT 'letsencrypt',
	`status` text NOT NULL DEFAULT 'pending',
	`issued_at` text,
	`expires_at` text,
	`auto_renew` integer NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `certificates_site_unique` ON `certificates` (`site_id`);
