CREATE TABLE `script` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`schedule` text NOT NULL,
	`code` text NOT NULL,
	`code_hash` text NOT NULL,
	`approved_hash` text,
	`approved_code` text,
	`approved_at` integer,
	`rejected_hash` text,
	`reject_reason` text,
	`enabled` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`last_run_ok` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `script_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`script_id` text NOT NULL,
	`trigger` text NOT NULL,
	`ok` integer NOT NULL,
	`output` text,
	`logs` text,
	`error` text,
	`duration_ms` integer NOT NULL,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`script_id`) REFERENCES `script`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `script_run_script_idx` ON `script_run` (`script_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `script_secret` (
	`name` text PRIMARY KEY NOT NULL,
	`value_enc` text NOT NULL,
	`hosts` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `script_state` (
	`script_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	FOREIGN KEY (`script_id`) REFERENCES `script`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `script_state_pk` ON `script_state` (`script_id`,`key`);