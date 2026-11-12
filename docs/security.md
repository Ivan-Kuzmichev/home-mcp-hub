# Security

**English** · [Русский](security.ru.md)

| Item | How it is covered |
| --- | --- |
| Admin | Registration is closed, 2FA is mandatory (TOTP + backup codes), 5 sign-in attempts per 15 min per IP, lockout after 5 wrong codes. Admin pages are also guarded in the middleware: without a session with 2FA you get an empty redirect to sign-in and the page is not rendered |
| Cookie | Over https: `__Host-hub.*`, Secure, HttpOnly, SameSite=Lax, Path=/. The session lasts 7 days and is extended on use |
| Secret prefix | The whole app lives under `/{prefix}/…`. The comparison takes constant time, everything without the prefix gets an empty 404 except `/p/*` and `/f/*`, root `/.well-known/*` is 404, the prefix is not written to the log, `Referrer-Policy: no-referrer`. The prefix hides the hub from scanners but does not replace OAuth and 2FA |
| OAuth | OAuth 2.1 with DCR. PKCE S256 only (`plain` is rejected). Redirects only to the client allowlist (Claude, ChatGPT; Claude Code with a switch). `aud` = `/{prefix}/api/mcp`. Client registration turns off after consent. Consent is possible only after 2FA |
| MCP | POST only, 60 requests per minute per client, 30 s timeout for services, optional CIDR allowlist, revoking a client takes effect immediately |
| Destructive tools | Deleting with files, deleting prototypes and scripts require `confirm: true` and are marked `destructiveHint` |
| Secrets | AES-256-GCM with `HUB_MASTER_KEY`, never shown in the admin panel or in replies. Keys live in `.env` (600) |
| Jackett | Links with the API key never reach replies, the cache or the log, only `result_id` does |
| Scripts | QuickJS sandbox. Network by switches, private addresses are checked at connect time (protection from DNS rebinding). Secrets are substituted only for their own hosts and scrubbed from the output. Only the approved version of the code runs |
| Files | Only the folders from the settings, each with its own mode (read / add / edit / delete). `..` and symbolic links pointing outside are rejected. Writes go through a temporary file. `/f/` links re-check the path and permissions on every open. You can additionally mount with `:ro`. The list of denied files (keys, `.env`, VPN configs by default) blocks reading, search, copying and links, so that the "Files + browser" combination can't become a channel for leaking secrets |
| mitmproxy | Tokens, passwords, keys, signatures, cookies, JWTs and `Bearer`/`Basic`/`Token` values in headers, URLs and bodies are masked (JSON is recognized even without `Content-Type`); the switch "Show tokens" turns this off. The mitmweb password is encrypted and kept out of the log. Mocks are off by default and the rules are data only (the addon runs no code and reads no files). In the log and in replies to the assistant a mock body is shown only as a length, and sensitive headers and JSON patch values (a secret name in any path segment or in the value's keys, Bearer, JWT) are replaced with `***`. Deleting all mocks requires `confirm`. The proxy sees all device traffic, so mitmweb is reachable only by the hub (`fw.allow.containers`) |
| camofox (browser) | Read-only by default, actions behind a switch. The address is checked before opening (http/https, public IPs after DNS, denylist → allowlist) and the final address after redirects is checked again. camofox keys never reach replies or the log, and text typed into forms appears in the log only as a length. No more than 3 concurrent requests. The main isolation is at the network level (the camofox container can reach only the internet) |
| Prototypes | CSP `sandbox` without `allow-same-origin`, `noindex`, the PIN is hashed with argon2, 5 attempts per 10 min per IP and 30 per prototype, random slug, 1 MB limit via MCP and 5 MB manually. The `window.hub.db` storage works with a token from the served page (HMAC, 24 h, reset when the PIN changes), without cookies, up to 50 MB |
| Log | Calls and sign-ins are kept for 30 days, failed sign-ins show on the dashboard. HTML, PINs and passwords are not written |
| Headers | HSTS (over https), `nosniff`, `no-referrer`. Admin pages use a CSP with a nonce and no inline scripts |
| Updates | Dependabot + image auto-update |
