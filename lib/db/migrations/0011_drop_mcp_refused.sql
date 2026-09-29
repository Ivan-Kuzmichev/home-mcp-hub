-- The refused-MCP diagnostics (v0.10.4–0.10.6) are gone: drop their journal lines and the «any client» preset.
DELETE FROM `tool_call` WHERE `tool` = 'auth.mcp_refused';--> statement-breakpoint
UPDATE `setting` SET `value` = replace(replace(replace(`value`, ',"any"', ''), '"any",', ''), '"any"', '') WHERE `key` = 'allowed_clients';
