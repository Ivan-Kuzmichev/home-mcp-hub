CREATE TABLE `papra_change` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	`document_id` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`undone_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `papra_change_batch_idx` ON `papra_change` (`batch_id`);