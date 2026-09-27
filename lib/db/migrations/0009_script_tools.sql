ALTER TABLE `script` ADD `kind` text DEFAULT 'cron' NOT NULL;--> statement-breakpoint
ALTER TABLE `script` ADD `spec` text;--> statement-breakpoint
ALTER TABLE `script` ADD `approved_spec` text;