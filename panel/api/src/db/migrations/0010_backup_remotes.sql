CREATE TABLE `backup_remotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`endpoint` text NOT NULL,
	`bucket` text NOT NULL,
	`region` text NOT NULL,
	`access_key_enc` text NOT NULL,
	`secret_key_enc` text NOT NULL,
	`enabled` integer NOT NULL DEFAULT 1,
	`created_at` text NOT NULL
);
