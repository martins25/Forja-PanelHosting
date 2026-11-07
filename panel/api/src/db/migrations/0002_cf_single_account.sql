-- One account per Cloudflare connection, and remember which account received the tunnel token.
-- If this fails, two accounts share a connection: unlink one of them and run it again.
CREATE UNIQUE INDEX `accounts_cf_connection_unique` ON `accounts` (`cf_connection_id`);--> statement-breakpoint
ALTER TABLE `cf_connections` ADD COLUMN `host_account_id` integer;
