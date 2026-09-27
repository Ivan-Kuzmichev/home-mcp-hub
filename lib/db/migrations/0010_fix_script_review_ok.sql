-- Script rejections were logged as failed auth events and counted as failed sign-ins.
UPDATE `tool_call` SET `ok` = 1, `args_redacted` = `args_redacted` || CASE WHEN `error` IS NOT NULL AND `error` <> 'без причины' THEN ' · причина: ' || `error` ELSE '' END, `error` = NULL WHERE `tool` = 'auth.script_review' AND `ok` = 0;
--> statement-breakpoint
-- cron_secrets was renamed to script_secrets: keep it switched off where it was.
UPDATE `connector` SET `disabled_tools` = replace(`disabled_tools`, '"cron_secrets"', '"script_secrets"') WHERE `id` = 'scripts';
