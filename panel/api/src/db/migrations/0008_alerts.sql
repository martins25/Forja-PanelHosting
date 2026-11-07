CREATE TABLE `alert_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`event` text NOT NULL,
	`channel_id` integer NOT NULL REFERENCES `alert_channels`(`id`),
	`threshold` text
);
--> statement-breakpoint
CREATE TABLE `alert_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL REFERENCES `alert_channels`(`id`),
	`event` text NOT NULL,
	`message` text NOT NULL,
	`sent_at` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_rules_event_idx` ON `alert_rules` (`event`);
