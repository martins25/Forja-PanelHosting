CREATE TABLE `site_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL REFERENCES `sites`(`id`),
	`date` text NOT NULL,
	`pageviews` integer NOT NULL DEFAULT 0,
	`unique_visitors` integer NOT NULL DEFAULT 0,
	`top_paths` text NOT NULL DEFAULT '[]',
	`top_referrers` text NOT NULL DEFAULT '[]',
	`top_countries` text NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_stats_site_date_unique` ON `site_stats` (`site_id`, `date`);
