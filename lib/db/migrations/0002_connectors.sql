CREATE TABLE `connector` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`config_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`disabled_tools` text DEFAULT '[]' NOT NULL,
	`last_check_at` integer,
	`last_check_ok` integer,
	`last_check_note` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_result` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`expires_at` integer NOT NULL
);
