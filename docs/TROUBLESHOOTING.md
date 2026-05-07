# Troubleshooting

Complete troubleshooting guide for Google Workspace MCP.

## Authentication Issues

### "OAuth credentials not found"

**Solution:**

- **Primary:** Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars in your MCP config
- **Secondary:** Download credentials from Google Cloud Console and save to `~/.config/google-workspace-mcp/credentials.json`
- Ensure the file has proper read permissions

### "Authentication failed" or Browser doesn't open

**Possible causes:**

1. **Wrong credential type**: Must be "Desktop app", not "Web application"
2. **Test user not added**: Add your email in OAuth consent screen

**Solution:**

The authentication server uses an ephemeral port assigned by the OS, so no specific ports need to be available. Verify your credentials are the correct type and re-run:

```bash
npx @dguido/google-workspace-mcp auth
```

### Running on remote/SSH/container environments

When running on a machine without a browser (SSH sessions, containers, WSL without browser integration), the auth flow provides a stdin fallback:

1. Run the auth command — it prints the auth URL and a paste prompt
2. Copy the auth URL and open it in your **local** browser
3. Authenticate with Google — the browser redirects to `http://127.0.0.1:<port>/...`
4. The redirect page won't load (the port is on the remote machine) — **this is expected**
5. Copy the full URL from your browser's address bar (it contains `?code=...&state=...`)
6. Paste it at the prompt on the remote machine

```
🔐 AUTHENTICATION REQUIRED
══════════════════════════════════════════

Opening your browser to authenticate...

Auth URL (copy if browser doesn't open):
  https://accounts.google.com/o/oauth2/v2/auth?client_id=...

If running remotely: open the URL in your local browser.
The redirect page won't load — copy the URL from your address bar
and paste it below.

Paste redirect URL or auth code: <paste here>
```

The stdin prompt only appears when a TTY is detected (interactive terminal). In non-interactive environments (piped input, MCP server mode), only the HTTP callback path is available.

### "Tokens expired" or "Invalid grant"

**For Google OAuth apps in "Testing" status:**

- Google automatically expires refresh tokens after 7 days
- You'll need to re-authenticate weekly until you publish your app
- Use `get_status` with `diagnose: true` to check token age and get warnings before expiry

**Solution:**

```bash
# Clear old tokens and re-authenticate
rm ~/.config/google-workspace-mcp/tokens.json
npx @dguido/google-workspace-mcp auth
```

**To avoid weekly re-authentication:**

1. **Publish your OAuth app** (recommended for personal use):
   - Go to Google Cloud Console > APIs & Services > OAuth consent screen
   - Click "PUBLISH APP"
   - You don't need to complete Google's verification for personal use
   - Published apps keep tokens valid indefinitely

2. **Use Internal app type** (Google Workspace only):
   - Set User Type to "Internal" on OAuth consent screen
   - Internal apps never expire tokens

**For production/public apps:**

- Complete OAuth verification process to remove user limits
- See [Google's OAuth verification guide](https://support.google.com/cloud/answer/9110914)

### "Login Required" error even with valid tokens

**If you updated the OAuth scopes but still get errors:**

- Google caches app authorizations even after removing local tokens
- The app might be using old/limited scopes

**Solution:**

1. Go to [Google Account Permissions](https://myaccount.google.com/permissions)
2. Find and remove access for "Google Drive MCP"
3. Clear local tokens: `rm ~/.config/google-workspace-mcp/tokens.json`
4. Re-authenticate to grant all required scopes
5. Verify the consent screen shows ALL scopes including full Drive access

## File Upload from Remote Clients

### "File not found at sourcePath" when uploading

When the MCP server runs on a **different machine** than the client (e.g., server on a VM, client on a workstation), the `sourcePath` parameter refers to the **server's local filesystem**, not the client's. A path like `/home/user/file.pdf` on the client doesn't exist on the server.

**Solutions (in order of preference):**

#### Option 1: Use a presigned URL via `sourceUrl` (recommended)

Stage the file to any HTTP-accessible store the MCP server can reach (e.g., S3 / MinIO with a short-lived presigned URL), then pass the URL as `sourceUrl`. The server fetches and uploads the bytes directly — no client-side base64, no shared filesystem required.

```json
{
  "name": "report.pdf",
  "sourceUrl": "https://minio.example.com/mcp-staging/<uuid>/report.pdf?X-Amz-Signature=...",
  "folderId": "..."
}
```

Same shape works for Gmail attachments via `attachments[].sourceUrl` on `send_email` / `draft_email`. Available in v4.5.0+.

#### Option 2: Use base64Content

For smaller files (under ~5MB), encode as base64 and pass directly:

```json
{
  "name": "file.pdf",
  "base64Content": "JVBERi0xLjcK...",
  "folderId": "..."
}
```

Works across any network topology but increases payload size by ~33%.

#### Option 3: Server-local `sourcePath`

If the client and server share a filesystem (e.g., a co-located staging directory), pass `sourcePath` pointing at a path the **server** can read. Less flexible than `sourceUrl` and only worth using when no HTTP-reachable store is available.

> **Note:** an earlier version of this guide recommended an `mcp-file-staging-service` HTTP shim on port 3201. That service has been retired in favour of `sourceUrl` + presigned URLs, which is simpler and more portable.

## API Issues

### "API not enabled" errors

```
Error: Google Sheets API has not been used in project...
```

**Solution:**

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select your project
3. Navigate to "APIs & Services" > "Library"
4. Search and enable the missing API
5. Wait 1-2 minutes for propagation

### "Insufficient permissions"

**Check scopes in your credentials:**

- Need drive.file or drive scope
- Need docs, sheets, slides scopes for respective services
- Need contacts scope for Contacts service

**Solution:**

- Re-create OAuth credentials with correct scopes
- Re-authenticate after updating credentials

### Rate Limiting (429 errors)

**Google API Quotas:**

- Drive API: 12,000 requests per minute
- Docs/Sheets/Slides: 300 requests per minute
- People API: 90 requests per minute (per user)

**Solution:**

- Implement exponential backoff
- Batch operations where possible
- Check quota usage in Google Cloud Console

## Getting Help

1. **Check logs**: Server logs errors to stderr
2. **Verify setup**: Run `npx @dguido/google-workspace-mcp help`
3. **Test auth**: Run `npx @dguido/google-workspace-mcp auth`
4. **Report issues**: [GitHub Issues](https://github.com/dguido/google-workspace-mcp/issues)
