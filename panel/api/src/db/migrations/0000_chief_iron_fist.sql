CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`linux_user` text NOT NULL,
	`uid` integer NOT NULL,
	`plan_id` integer,
	`cf_connection_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cf_connection_id`) REFERENCES `cf_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_slug_unique` ON `accounts` (`slug`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`actor_user_id` integer,
	`actor_kind` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`params_redacted` text,
	`result` text NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE TABLE `backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`site_id` integer,
	`kind` text NOT NULL,
	`restic_snapshot_id` text,
	`size_bytes` integer,
	`includes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cf_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` integer,
	`cf_account_id` text NOT NULL,
	`api_token_enc` text NOT NULL,
	`tunnel_id` text,
	`tunnel_token_enc` text,
	`managed_by` text DEFAULT 'admin' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `databases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`engine` text NOT NULL,
	`name` text NOT NULL,
	`db_user` text NOT NULL,
	`password_enc` text NOT NULL,
	`web_tool` text DEFAULT 'none' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`commit_sha` text,
	`commit_message` text,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` text,
	`finished_at` text,
	`log_path` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`hostname` text NOT NULL,
	`kind` text DEFAULT 'primary' NOT NULL,
	`cert` text DEFAULT 'cloudflare' NOT NULL,
	`cert_expires_at` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `env_vars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`key` text NOT NULL,
	`value_enc` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `git_integrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`base_url` text,
	`owner_user_id` integer,
	`credentials_enc` text NOT NULL,
	`webhook_secret_enc` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`cpu_millis` integer NOT NULL,
	`memory_mb` integer NOT NULL,
	`disk_mb` integer NOT NULL,
	`max_sites` integer NOT NULL,
	`max_databases` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_name_unique` ON `plans` (`name`);--> statement-breakpoint
CREATE TABLE `removal_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`requested_by` integer NOT NULL,
	`reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`expires_at` text NOT NULL,
	`ip_hash` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`primary_domain` text NOT NULL,
	`runtime` text NOT NULL,
	`runtime_version` text,
	`source` text,
	`repo` text,
	`branch` text,
	`install_cmd` text,
	`build_cmd` text,
	`start_cmd` text,
	`internal_port` integer,
	`public_dir` text,
	`mode` text DEFAULT 'online' NOT NULL,
	`notice_title` text,
	`notice_message` text,
	`notice_eta` text,
	`autodeploy` integer DEFAULT true NOT NULL,
	`stats_enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stats_daily` (
	`site_id` integer NOT NULL,
	`day` text NOT NULL,
	`path` text NOT NULL,
	`country` text DEFAULT '' NOT NULL,
	`referrer_host` text DEFAULT '' NOT NULL,
	`device` text DEFAULT '' NOT NULL,
	`browser` text DEFAULT '' NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`visits` integer DEFAULT 0 NOT NULL,
	`uniques` integer DEFAULT 0 NOT NULL,
	`status_2xx` integer DEFAULT 0 NOT NULL,
	`status_4xx` integer DEFAULT 0 NOT NULL,
	`status_5xx` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `path`, `country`, `referrer_host`, `device`, `browser`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_accounts` (
	`user_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret_enc` text,
	`webauthn_credentials` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`last_login_at` text,
	`disabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`delivery_id` text NOT NULL,
	`site_id` integer,
	`received_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`signature_ok` integer NOT NULL,
	`processed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
