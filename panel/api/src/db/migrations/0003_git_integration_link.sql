-- Link a site to the Git integration (Gitea instance) it was created from.
ALTER TABLE `sites` ADD COLUMN `git_integration_id` integer REFERENCES `git_integrations`(`id`);
