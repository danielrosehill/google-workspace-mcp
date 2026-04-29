# Customization Plan

Forked from [dguido/google-workspace-mcp](https://github.com/dguido/google-workspace-mcp) (v3.4.4, MIT license).

## Goal

A multi-workspace Google Workspace MCP server that supports two (or more) Google accounts via a `workspace` parameter on every tool, with exactly the services and tools needed — no bloat.

## Deployment Model

This MCP server is **not** designed to run on the end-user's machine. It runs on a **centrally managed server** (local or remote) behind an MCP aggregator such as [MCP Jungle](https://github.com/danielrosehill/MCP-Architecture-0426).

```
┌─────────────────────┐
│  User's machine     │
│  (Claude Code, etc) │
│                     │
│  MCP client config: │
│  → aggregator URL   │
│    (user-level)     │
└────────┬────────────┘
         │ streamable HTTP
         ▼
┌─────────────────────┐
│  MCP Aggregator     │
│  (MCP Jungle)       │
│  10.0.0.4 / remote  │
│                     │
│  Routes to upstream │
│  MCP servers        │
└────────┬────────────┘
         │ stdio / HTTP
         ▼
┌─────────────────────────────┐
│  This MCP server            │
│  google-workspace-mcp       │
│                             │
│  Stores credentials on the  │
│  server filesystem:         │
│  /opt/mcp/gws/credentials/  │
│    ├── workspaces.json      │
│    ├── personal/            │
│    │   ├── client.json      │
│    │   └── token.json       │
│    └── business/            │
│        ├── client.json      │
│        └── token.json       │
└─────────────────────────────┘
```

**Key implications:**

- The user **never** handles OAuth credentials or tokens — they just point their MCP client at the aggregator URL
- Credentials and refresh tokens live persistently on the central server's filesystem
- OAuth consent flow runs once per workspace on the server (via CLI or redirect to localhost on the server)
- Token refresh is automatic and transparent — the server handles it
- The server must support **streamable HTTP** transport (not just stdio) for aggregator connectivity

## Architecture Changes

### 1. Multi-workspace support

Add a `workspace` parameter (string enum) to every tool schema. Each workspace maps to its own OAuth credentials and token file stored on the server.

```
workspace: "personal" | "business"
```

Server-side config (`/opt/mcp/gws/credentials/workspaces.json`):

```json
{
  "personal": {
    "label": "personal",
    "email": "daniel@danielrosehill.co.il",
    "clientCredentials": "/opt/mcp/gws/credentials/personal/client.json",
    "tokenPath": "/opt/mcp/gws/credentials/personal/token.json"
  },
  "business": {
    "label": "business",
    "email": "daniel@dsrholdings.cloud",
    "clientCredentials": "/opt/mcp/gws/credentials/business/client.json",
    "tokenPath": "/opt/mcp/gws/credentials/business/token.json"
  }
}
```

Can also be configured via env vars for containerized deployments:

```
GWS_WORKSPACES_CONFIG=/opt/mcp/gws/credentials/workspaces.json
```

The auth layer (`src/auth/`) resolves workspace → credentials at call time. Each workspace gets its own `OAuth2Client` instance, cached after first use.

### 2. Auth & Credential Management

**Initial setup (one-time per workspace):**

1. Place GCP OAuth client credentials (`client.json`) on the server
2. Run a setup CLI command: `npx google-workspace-mcp auth --workspace personal`
3. This opens a browser / prints a URL for OAuth consent
4. On completion, `token.json` (with refresh token) is written to the workspace's directory
5. Subsequent requests use the refresh token automatically

**Token lifecycle:**

- Access tokens expire after ~1 hour — the Google client library handles refresh automatically using the stored refresh token
- If a refresh token is revoked or expires, the tool returns a clear error indicating re-auth is needed for that workspace
- No credentials or tokens are ever sent to or stored on the user's machine

**Security considerations:**

- Credential directory should be readable only by the MCP server process (`chmod 700`)
- In Docker deployments, mount the credential directory as a volume
- The `workspaces.json` file and token files should never be committed to git (already in `.gitignore`)

### 3. Transport

Streamable HTTP transport is **required** (not optional) for the aggregator deployment model. stdio is retained for local development and testing only.

The server listens on a configurable port:

```
GWS_MCP_PORT=3100
GWS_MCP_HOST=127.0.0.1
```

In production behind the aggregator, it binds to localhost only — the aggregator handles external connectivity and TLS.

### 3. Tool surface — keep only what's needed

#### Gmail (priority: highest)

- `gmail_search` — search messages
- `gmail_read` — read message content
- `gmail_draft` — create draft (plain/HTML, with optional attachments)
- `gmail_send` — send email (plain/HTML, with optional attachments)
- `gmail_list_labels` — list labels (phase 2)
- `gmail_manage_labels` — create/update/delete labels (phase 2)
- `gmail_modify_labels` — add/remove labels from messages (phase 2)

#### Calendar

- `calendar_list` — list calendars
- `calendar_get_events` — get events by date range
- `calendar_create_event` — create event (with attendees, recurrence)
- `calendar_update_event` — modify event
- `calendar_delete_event` — delete event

#### Contacts

- `contacts_list` — list contacts
- `contacts_search` — search contacts
- `contacts_create` — create contact
- `contacts_update` — update contact
- `contacts_delete` — delete contact

#### Drive

- `drive_list` — list files/folders
- `drive_search` — search files
- `drive_read` — read file content
- `drive_upload` — upload file
- `drive_create_folder` — create folder
- `drive_move` — move/rename
- `drive_share` — manage permissions

#### Docs

- `docs_create` — create document
- `docs_read` — read content
- `docs_modify` — modify text
- `docs_insert` — insert elements
- `docs_export_pdf` — export to PDF
- `docs_comments` — read/create/reply/resolve comments

#### Sheets (lowest priority)

- `sheets_create` — create spreadsheet
- `sheets_read` — read cell values
- `sheets_write` — write/modify cells
- `sheets_info` — get spreadsheet metadata

### 4. Remove

- Slides handler (`src/handlers/slides.ts`, `src/schemas/slides.ts`) — not needed
- Unified search handler — not needed
- Discovery handler — not needed
- Prompts — not needed

## Phases

### Phase 1 — Multi-workspace + Gmail

- Add workspace config/resolution layer
- Wire workspace param into all Gmail tools
- Verify attachment send/draft works
- Add streamable HTTP transport
- Deploy to MCP Jungle

### Phase 2 — Calendar + Contacts + Drive

- Wire workspace into remaining handlers
- Trim tool surface to only what's listed above

### Phase 3 — Docs + Sheets

- Wire workspace into docs/sheets
- Trim tool surface

### Phase 4 — Cleanup

- Remove unused handlers (slides, unified, discovery)
- Remove unused schemas, tests, utils
- Update README
- Publish to npm
