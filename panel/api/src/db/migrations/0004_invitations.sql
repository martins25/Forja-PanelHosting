CREATE TABLE `invitations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token` text NOT NULL,
	`created_by` integer NOT NULL REFERENCES `users`(`id`),
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`created_at` text NOT NULL DEFAULT 'CURRENT_TIMESTAMP'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_unique` ON `invitations` (`token`);
--> statement-breakpoint
CREATE TABLE `invitation_accounts` (
	`invitation_id` integer NOT NULL REFERENCES `invitations`(`id`),
	`account_id` integer NOT NULL REFERENCES `accounts`(`id`),
	PRIMARY KEY(`invitation_id`, `account_id`)
);
