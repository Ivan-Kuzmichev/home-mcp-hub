CREATE TABLE `download_link` (
	`token` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`document_id` integer NOT NULL,
	`original` integer DEFAULT false NOT NULL,
	`shareable` integer DEFAULT false NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paperless_change` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	`document_id` integer NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`undone_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `paperless_change_batch_idx` ON `paperless_change` (`batch_id`);