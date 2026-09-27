ALTER TABLE `connector` ADD `instructions_mode` text DEFAULT 'append' NOT NULL;--> statement-breakpoint
ALTER TABLE `connector` ADD `instructions_text` text;--> statement-breakpoint
UPDATE `connector` SET `instructions_text` = json_extract(`config_enc`, '$.instructions'), `config_enc` = json_remove(`config_enc`, '$.instructions') WHERE `id` = 'torrserve' AND json_extract(`config_enc`, '$.instructions') IS NOT NULL;
