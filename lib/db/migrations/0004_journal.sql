CREATE TABLE `tool_call` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool` text NOT NULL,
	`connector_id` text NOT NULL,
	`args_redacted` text NOT NULL,
	`ok` integer NOT NULL,
	`result_summary` text,
	`error` text,
	`duration_ms` integer,
	`client_id` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_call_created_at_idx` ON `tool_call` (`created_at`);--> statement-breakpoint
CREATE INDEX `tool_call_client_idx` ON `tool_call` (`client_id`);