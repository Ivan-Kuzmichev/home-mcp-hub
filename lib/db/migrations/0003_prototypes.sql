CREATE TABLE `prototype` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`pin_hash` text,
	`pin_version` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`size_bytes` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prototype_slug_unique` ON `prototype` (`slug`);