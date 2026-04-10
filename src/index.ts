#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import type { drive_v3, docs_v1, sheets_v4, slides_v1, calendar_v3, gmail_v1, people_v1 } from "googleapis";
import {
  authenticate,
  AuthServer,
  initializeOAuth2Client,
  getWorkspaceServices,
} from "./auth.js";
import type { OAuth2Client } from "google-auth-library";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { createServer as createHttpServer } from "http";

// Import utilities
import {
  log,
  errorResponse,
  authErrorResponse,
  isConfigurationError,
  DIAGNOSTIC_HINT,
  getDocsService,
  getSheetsService,
  getSlidesService,
  getCalendarService,
  getGmailService,
  getPeopleService,
} from "./utils/index.js";
import type { ToolResponse } from "./utils/index.js";

// Import service configuration
import {
  isServiceEnabled,
  areUnifiedToolsEnabled,
  getEnabledServices,
  isReadOnlyMode,
  getWorkspace,
  loadWorkspacesConfig,
} from "./config/index.js";

// Import auth utilities for startup logging
import {
  getSecureTokenPath,
  getKeysFilePath,
  getConfigDirectory,
  getActiveProfile,
  getEnvVarCredentials,
} from "./auth/utils.js";

// Import all tool definitions
import { getAllTools } from "./tools/index.js";

// Import error utilities
import { mapGoogleError, isGoogleApiError, GoogleAuthError } from "./errors/index.js";

// Import prompts
import { PROMPTS, generatePromptMessages } from "./prompts/index.js";

// Import all handlers
import {
  // Drive handlers
  handleSearch,
  handleCreateTextFile,
  handleUpdateTextFile,
  handleCreateFolder,
  handleListFolder,
  handleDeleteItem,
  handleRenameItem,
  handleMoveItem,
  handleCopyFile,
  handleGetFileMetadata,
  handleExportFile,
  handleShareFile,
  handleGetSharing,
  handleListRevisions,
  handleRestoreRevision,
  handleDownloadFile,
  handleUploadFile,
  handleGetStorageQuota,
  handleStarFile,
  handleResolveFilePath,
  handleBatchDelete,
  handleBatchRestore,
  handleBatchMove,
  handleBatchShare,
  handleRemovePermission,
  handleListTrash,
  handleRestoreFromTrash,
  handleEmptyTrash,
  handleGetFolderTree,
  // Docs handlers
  handleCreateGoogleDoc,
  handleUpdateGoogleDoc,
  handleGetGoogleDocContent,
  handleAppendToDoc,
  handleInsertTextInDoc,
  handleDeleteTextInDoc,
  handleReplaceTextInDoc,
  handleFormatGoogleDocRange,
  // Sheets handlers
  handleCreateGoogleSheet,
  handleUpdateGoogleSheet,
  handleGetGoogleSheetContent,
  handleFormatGoogleSheetCells,
  handleMergeGoogleSheetCells,
  handleAddGoogleSheetConditionalFormat,
  handleSheetTabs,
  // Slides handlers
  handleCreateGoogleSlides,
  handleUpdateGoogleSlides,
  handleGetGoogleSlidesContent,
  handleCreateGoogleSlidesTextBox,
  handleCreateGoogleSlidesShape,
  handleSlidesSpeakerNotes,
  handleFormatSlidesText,
  handleFormatSlidesShape,
  handleFormatSlideBackground,
  handleListSlidePages,
  // Unified handlers
  handleCreateFile,
  handleUpdateFile,
  handleGetFileContent,
  // Calendar handlers
  handleListCalendars,
  handleListEvents,
  handleGetEvent,
  handleCreateEvent,
  handleUpdateEvent,
  handleDeleteEvent,
  handleFindFreeTime,
  // Gmail handlers
  handleSendEmail,
  handleDraftEmail,
  handleDeleteDraft,
  handleListDrafts,
  handleReadEmail,
  handleSearchEmails,
  handleDeleteEmail,
  handleModifyEmail,
  handleDownloadAttachment,
  handleCreateLabel,
  handleUpdateLabel,
  handleDeleteLabel,
  handleListLabels,
  handleGetOrCreateLabel,
  handleCreateFilter,
  handleListFilters,
  handleDeleteFilter,
  // Contacts handlers
  handleListContacts,
  handleGetContact,
  handleSearchContacts,
  handleCreateContact,
  handleUpdateContact,
  handleDeleteContact,
  // Discovery handlers
  handleListTools,
  // Status handler
  handleGetStatus,
} from "./handlers/index.js";
import type { HandlerContext } from "./handlers/index.js";

// -----------------------------------------------------------------------------
// CONSTANTS & GLOBAL STATE
// -----------------------------------------------------------------------------

// Drive service - will be created with auth when needed
let drive: drive_v3.Drive | null = null;

// Global auth client - will be initialized on first use
let authClient: OAuth2Client | null = null;
let authenticationPromise: Promise<OAuth2Client> | null = null;

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "package.json");
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Package.json structure is known
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };
const VERSION = packageJson.version;

// -----------------------------------------------------------------------------
// DRIVE SERVICE HELPER
// -----------------------------------------------------------------------------

function ensureDriveService() {
  if (!authClient) {
    throw new Error("Authentication required");
  }

  log("About to create drive service", {
    authClientType: authClient?.constructor?.name,
    hasCredentials: !!authClient.credentials,
    hasAccessToken: !!authClient.credentials?.access_token,
    isExpired: authClient.credentials?.expiry_date
      ? Date.now() > authClient.credentials.expiry_date
      : "no expiry",
  });

  // Create drive service with auth parameter directly
  drive = google.drive({ version: "v3", auth: authClient });

  log("Drive service created/updated", {
    hasAuth: !!authClient,
    hasCredentials: !!authClient.credentials,
    hasAccessToken: !!authClient.credentials?.access_token,
  });
}

// Track auth health for debugging
let lastAuthError: string | null = null;

async function verifyAuthHealth(): Promise<boolean> {
  if (!drive) {
    lastAuthError = "Drive service not initialized";
    return false;
  }

  try {
    const response = await drive.about.get({ fields: "user" });
    const email = response.data.user?.emailAddress;
    const atIdx = email ? email.lastIndexOf("@") : -1;
    const redactedUser =
      email && atIdx > 0 ? `${email[0]}***@${email.slice(atIdx + 1)}` : "unknown";
    log("Auth verification successful", { user: redactedUser });
    lastAuthError = null;
    return true;
  } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Accessing error properties
    const err = error as {
      message?: string;
      response?: { status: number; statusText: string };
    };
    lastAuthError = err.message || String(error);
    log("WARNING: Auth verification failed:", lastAuthError);
    if (err.response) {
      log("Auth error details:", {
        status: err.response.status,
        statusText: err.response.statusText,
      });
    }
    return false;
  }
}

// Export for testing - allows checking last auth error
export function getLastAuthError(): string | null {
  return lastAuthError;
}

// -----------------------------------------------------------------------------
// SERVER FACTORY
// -----------------------------------------------------------------------------

function createMcpServer(defaultWorkspace?: string): Server {
  const s = new Server(
    {
      name: "google-workspace-mcp",
      version: VERSION,
    },
    {
      instructions:
        "On any tool error, call get_status for diagnostics " + "before asking the user to debug.",
      capabilities: {
        resources: {},
        tools: {
          listChanged: true,
        },
        prompts: {
          listChanged: true,
        },
      },
    },
  );

  registerHandlers(s, defaultWorkspace);
  return s;
}

// Singleton for stdio mode (set in main)
let server: Server;

// -----------------------------------------------------------------------------
// AUTHENTICATION HELPER
// -----------------------------------------------------------------------------

async function ensureAuthenticated() {
  if (!authClient) {
    // If authentication is already in progress, wait for it
    if (authenticationPromise) {
      log("Authentication already in progress, waiting...");
      authClient = await authenticationPromise;
      return;
    }

    log("Initializing authentication");
    // Store the promise to prevent concurrent authentication attempts
    authenticationPromise = authenticate();

    try {
      authClient = await authenticationPromise;
      const hasCredentials = !!authClient?.credentials;
      const hasAccessToken = !!authClient?.credentials?.access_token;
      log("Authentication complete", {
        authClientType: authClient?.constructor?.name,
        hasCredentials,
        hasAccessToken,
      });
      // Ensure drive service is created with auth
      ensureDriveService();

      // Verify auth works by making a test API call (blocking on first auth)
      const healthy = await verifyAuthHealth();
      if (!healthy) {
        log("WARNING: Authentication may be broken. Tool calls may fail.");
      }
    } finally {
      // Clear the promise after completion (success or failure)
      authenticationPromise = null;
    }
  }

  // If we already have authClient, ensure drive is up to date
  ensureDriveService();
}

// -----------------------------------------------------------------------------
// MCP REQUEST HANDLERS
// -----------------------------------------------------------------------------

function registerHandlers(s: Server, defaultWorkspace?: string): void {

s.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  await ensureAuthenticated();
  log("Handling ListResources request", { params: request.params });
  const pageSize = 10;
  const params: {
    pageSize: number;
    fields: string;
    pageToken?: string;
    q: string;
    includeItemsFromAllDrives: boolean;
    supportsAllDrives: boolean;
  } = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
    q: `trashed = false`,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }

  const res = await drive!.files.list(params);
  log("Listed files", { count: res.data.files?.length });
  const files = res.data.files || [];

  return {
    resources: files.map((file: drive_v3.Schema$File) => ({
      uri: `gdrive:///${file.id}`,
      mimeType: file.mimeType || "application/octet-stream",
      name: file.name || "Untitled",
    })),
    nextCursor: res.data.nextPageToken,
  };
});

s.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  await ensureAuthenticated();
  log("Handling ReadResource request", { uri: request.params.uri });
  const fileId = request.params.uri.replace("gdrive:///", "");

  const file = await drive!.files.get({
    fileId,
    fields: "mimeType",
    supportsAllDrives: true,
  });
  const mimeType = file.data.mimeType;

  if (!mimeType) {
    throw new Error("File has no MIME type.");
  }

  if (mimeType.startsWith("application/vnd.google-apps")) {
    // Export logic for Google Docs/Sheets/Slides
    let exportMimeType;
    switch (mimeType) {
      case "application/vnd.google-apps.document":
        exportMimeType = "text/markdown";
        break;
      case "application/vnd.google-apps.spreadsheet":
        exportMimeType = "text/csv";
        break;
      case "application/vnd.google-apps.presentation":
        exportMimeType = "text/plain";
        break;
      case "application/vnd.google-apps.drawing":
        exportMimeType = "image/png";
        break;
      default:
        exportMimeType = "text/plain";
        break;
    }

    const res = await drive!.files.export(
      { fileId, mimeType: exportMimeType },
      { responseType: "text" },
    );

    log("Successfully read resource", { fileId, mimeType });
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: exportMimeType,
          text: res.data,
        },
      ],
    };
  } else {
    // Regular file download
    const res = await drive!.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    const contentMime = mimeType || "application/octet-stream";

    if (contentMime.startsWith("text/") || contentMime === "application/json") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: contentMime,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Google API response data
            text: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
          },
        ],
      };
    } else {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: contentMime,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Google API response data
            blob: Buffer.from(res.data as ArrayBuffer).toString("base64"),
          },
        ],
      };
    }
  }
});

s.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getAllTools() };
});

// -----------------------------------------------------------------------------
// PROMPT REQUEST HANDLERS
// -----------------------------------------------------------------------------

s.setRequestHandler(ListPromptsRequestSchema, async () => {
  log("Handling ListPrompts request");
  return {
    prompts: PROMPTS.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  };
});

s.setRequestHandler(GetPromptRequestSchema, async (request) => {
  log("Handling GetPrompt request", { name: request.params.name });

  const promptName = request.params.name;
  const promptDef = PROMPTS.find((p) => p.name === promptName);

  if (!promptDef) {
    throw new Error(`Unknown prompt: ${promptName}`);
  }

  const args = request.params.arguments || {};
  const messages = generatePromptMessages(promptName, args);

  return {
    description: promptDef.description,
    messages,
  };
});

// -----------------------------------------------------------------------------
// TOOL REGISTRY
// -----------------------------------------------------------------------------

interface ToolServices {
  drive: drive_v3.Drive;
  docs: docs_v1.Docs;
  sheets: sheets_v4.Sheets;
  slides: slides_v1.Slides;
  calendar: calendar_v3.Calendar;
  gmail: gmail_v1.Gmail;
  people: people_v1.People;
  context: HandlerContext;
}

type ToolHandler = (services: ToolServices, args: unknown) => Promise<ToolResponse>;

function createToolRegistry(): Record<string, ToolHandler> {
  const registry: Record<string, ToolHandler> = {};

  // Discovery and status tools (always available, no auth required for status)
  Object.assign(registry, {
    list_tools: (_services, args) => handleListTools(args),
    get_status: ({ drive }, args) => handleGetStatus(authClient, drive, VERSION, args),
  } satisfies Record<string, ToolHandler>);

  // Drive tools
  if (isServiceEnabled("drive")) {
    Object.assign(registry, {
      search: ({ drive }, args) => handleSearch(drive, args),
      create_text_file: ({ drive }, args) => handleCreateTextFile(drive, args),
      update_text_file: ({ drive }, args) => handleUpdateTextFile(drive, args),
      create_folder: ({ drive }, args) => handleCreateFolder(drive, args),
      list_folder: ({ drive }, args) => handleListFolder(drive, args),
      delete_item: ({ drive }, args) => handleDeleteItem(drive, args),
      rename_item: ({ drive }, args) => handleRenameItem(drive, args),
      move_item: ({ drive }, args) => handleMoveItem(drive, args),
      copy_file: ({ drive }, args) => handleCopyFile(drive, args),
      get_file_metadata: ({ drive }, args) => handleGetFileMetadata(drive, args),
      export_file: ({ drive }, args) => handleExportFile(drive, args),
      share_file: ({ drive }, args) => handleShareFile(drive, args),
      get_sharing: ({ drive }, args) => handleGetSharing(drive, args),
      list_revisions: ({ drive }, args) => handleListRevisions(drive, args),
      restore_revision: ({ drive }, args) => handleRestoreRevision(drive, args),
      download_file: ({ drive }, args) => handleDownloadFile(drive, args),
      upload_file: ({ drive }, args) => handleUploadFile(drive, args),
      get_storage_quota: ({ drive }, args) => handleGetStorageQuota(drive, args),
      star_file: ({ drive }, args) => handleStarFile(drive, args),
      resolve_file_path: ({ drive, context }, args) => handleResolveFilePath(drive, args, context),
      batch_delete: ({ drive, context }, args) => handleBatchDelete(drive, args, context),
      batch_restore: ({ drive, context }, args) => handleBatchRestore(drive, args, context),
      batch_move: ({ drive, context }, args) => handleBatchMove(drive, args, context),
      batch_share: ({ drive, context }, args) => handleBatchShare(drive, args, context),
      remove_permission: ({ drive }, args) => handleRemovePermission(drive, args),
      list_trash: ({ drive }, args) => handleListTrash(drive, args),
      restore_from_trash: ({ drive }, args) => handleRestoreFromTrash(drive, args),
      empty_trash: ({ drive, context }, args) => handleEmptyTrash(drive, args, context),
      get_folder_tree: ({ drive }, args) => handleGetFolderTree(drive, args),
    } satisfies Record<string, ToolHandler>);
  }

  // Docs tools
  if (isServiceEnabled("docs")) {
    Object.assign(registry, {
      create_google_doc: ({ drive, docs }, args) => handleCreateGoogleDoc(drive, docs, args),
      update_google_doc: ({ docs }, args) => handleUpdateGoogleDoc(docs, args),
      get_google_doc_content: ({ drive, docs }, args) =>
        handleGetGoogleDocContent(drive, docs, args),
      append_to_doc: ({ docs }, args) => handleAppendToDoc(docs, args),
      insert_text_in_doc: ({ docs }, args) => handleInsertTextInDoc(docs, args),
      delete_text_in_doc: ({ docs }, args) => handleDeleteTextInDoc(docs, args),
      replace_text_in_doc: ({ docs }, args) => handleReplaceTextInDoc(docs, args),
      format_google_doc_range: ({ docs }, args) => handleFormatGoogleDocRange(docs, args),
    } satisfies Record<string, ToolHandler>);
  }

  // Sheets tools
  if (isServiceEnabled("sheets")) {
    Object.assign(registry, {
      create_google_sheet: ({ drive, sheets }, args) =>
        handleCreateGoogleSheet(drive, sheets, args),
      update_google_sheet: ({ sheets }, args) => handleUpdateGoogleSheet(sheets, args),
      get_google_sheet_content: ({ drive, sheets }, args) =>
        handleGetGoogleSheetContent(drive, sheets, args),
      format_google_sheet_cells: ({ sheets }, args) => handleFormatGoogleSheetCells(sheets, args),
      merge_google_sheet_cells: ({ sheets }, args) => handleMergeGoogleSheetCells(sheets, args),
      add_google_sheet_conditional_format: ({ sheets }, args) =>
        handleAddGoogleSheetConditionalFormat(sheets, args),
      sheet_tabs: ({ sheets }, args) => handleSheetTabs(sheets, args),
    } satisfies Record<string, ToolHandler>);
  }

  // Slides tools
  if (isServiceEnabled("slides")) {
    Object.assign(registry, {
      create_google_slides: ({ drive, slides }, args) =>
        handleCreateGoogleSlides(drive, slides, args),
      update_google_slides: ({ slides }, args) => handleUpdateGoogleSlides(slides, args),
      get_google_slides_content: ({ drive, slides }, args) =>
        handleGetGoogleSlidesContent(drive, slides, args),
      create_google_slides_text_box: ({ slides }, args) =>
        handleCreateGoogleSlidesTextBox(slides, args),
      create_google_slides_shape: ({ slides }, args) => handleCreateGoogleSlidesShape(slides, args),
      slides_speaker_notes: ({ slides }, args) => handleSlidesSpeakerNotes(slides, args),
      format_slides_text: ({ slides }, args) => handleFormatSlidesText(slides, args),
      format_slides_shape: ({ slides }, args) => handleFormatSlidesShape(slides, args),
      format_slide_background: ({ slides }, args) => handleFormatSlideBackground(slides, args),
      list_slide_pages: ({ slides }, args) => handleListSlidePages(slides, args),
    } satisfies Record<string, ToolHandler>);
  }

  // Unified smart tools (require drive+docs+sheets+slides)
  if (areUnifiedToolsEnabled()) {
    Object.assign(registry, {
      create_file: ({ drive, docs, sheets, slides }, args) =>
        handleCreateFile(drive, docs, sheets, slides, args),
      update_file: ({ drive, docs, sheets, slides }, args) =>
        handleUpdateFile(drive, docs, sheets, slides, args),
      get_file_content: ({ drive, docs, sheets, slides }, args) =>
        handleGetFileContent(drive, docs, sheets, slides, args),
    } satisfies Record<string, ToolHandler>);
  }

  // Calendar tools
  if (isServiceEnabled("calendar")) {
    Object.assign(registry, {
      list_calendars: ({ calendar }, args) => handleListCalendars(calendar, args),
      list_events: ({ calendar }, args) => handleListEvents(calendar, args),
      get_event: ({ calendar }, args) => handleGetEvent(calendar, args),
      create_event: ({ calendar }, args) => handleCreateEvent(calendar, args),
      update_event: ({ calendar }, args) => handleUpdateEvent(calendar, args),
      delete_event: ({ calendar }, args) => handleDeleteEvent(calendar, args),
      find_free_time: ({ calendar }, args) => handleFindFreeTime(calendar, args),
    } satisfies Record<string, ToolHandler>);
  }

  // Gmail tools
  if (isServiceEnabled("gmail")) {
    Object.assign(registry, {
      send_email: ({ gmail }, args) => handleSendEmail(gmail, args),
      draft_email: ({ gmail }, args) => handleDraftEmail(gmail, args),
      delete_draft: ({ gmail }, args) => handleDeleteDraft(gmail, args),
      list_drafts: ({ gmail }, args) => handleListDrafts(gmail, args),
      read_email: ({ gmail }, args) => handleReadEmail(gmail, args),
      search_emails: ({ gmail }, args) => handleSearchEmails(gmail, args),
      delete_email: ({ gmail }, args) => handleDeleteEmail(gmail, args),
      modify_email: ({ gmail }, args) => handleModifyEmail(gmail, args),
      download_attachment: ({ gmail }, args) => handleDownloadAttachment(gmail, args),
      create_label: ({ gmail }, args) => handleCreateLabel(gmail, args),
      update_label: ({ gmail }, args) => handleUpdateLabel(gmail, args),
      delete_label: ({ gmail }, args) => handleDeleteLabel(gmail, args),
      list_labels: ({ gmail }, args) => handleListLabels(gmail, args),
      get_or_create_label: ({ gmail }, args) => handleGetOrCreateLabel(gmail, args),
      create_filter: ({ gmail }, args) => handleCreateFilter(gmail, args),
      list_filters: ({ gmail }, args) => handleListFilters(gmail, args),
      delete_filter: ({ gmail }, args) => handleDeleteFilter(gmail, args),
    } satisfies Record<string, ToolHandler>);
  }

  // Contacts tools
  if (isServiceEnabled("contacts")) {
    Object.assign(registry, {
      list_contacts: ({ people }, args) => handleListContacts(people, args),
      get_contact: ({ people }, args) => handleGetContact(people, args),
      search_contacts: ({ people }, args) => handleSearchContacts(people, args),
      create_contact: ({ people }, args) => handleCreateContact(people, args),
      update_contact: ({ people }, args) => handleUpdateContact(people, args),
      delete_contact: ({ people }, args) => handleDeleteContact(people, args),
    } satisfies Record<string, ToolHandler>);
  }

  // In read-only mode, remove write tools from the registry
  if (isReadOnlyMode()) {
    const readOnlyTools = new Set(getAllTools().map((t) => t.name));
    for (const name of Object.keys(registry)) {
      if (!readOnlyTools.has(name)) {
        delete registry[name];
      }
    }
  }

  return registry;
}

const toolRegistry = createToolRegistry();


// -----------------------------------------------------------------------------
// TOOL CALL REQUEST HANDLER
// -----------------------------------------------------------------------------

s.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments;

  // Status/discovery tools work without auth
  if (toolName === "get_status") {
    return handleGetStatus(authClient, drive, VERSION, args);
  }
  if (toolName === "list_tools") {
    return handleListTools(args);
  }

  log("Handling tool request", { tool: toolName });

  try {
    const meta = (request.params as { _meta?: { progressToken?: string | number } })._meta;
    const context: HandlerContext = { server: s, progressToken: meta?.progressToken };

    // Inject defaultWorkspace (from path-based URL) into args so downstream
    // Zod schemas that require `workspace` pass validation even when the
    // caller relies on the URL path instead of an explicit parameter.
    const mergedArgs: Record<string, unknown> = { ...(args ?? {}) };
    if (!mergedArgs.workspace && defaultWorkspace) {
      mergedArgs.workspace = defaultWorkspace;
    }
    const workspace = (mergedArgs.workspace as string) || defaultWorkspace;

    let services: ToolServices;

    if (workspace) {
      // Workspace-based auth: all tools can use this
      const ws = await getWorkspaceServices(workspace);
      services = {
        drive: ws.drive,
        docs: ws.docs,
        sheets: ws.sheets,
        slides: ws.slides,
        calendar: ws.calendar,
        gmail: ws.gmail,
        people: ws.people,
        context,
      };
    } else {
      // Legacy singleton auth fallback (stdio / single-account mode)
      await ensureAuthenticated();
      services = {
        drive: drive!,
        docs: getDocsService(authClient!),
        sheets: getSheetsService(authClient!),
        slides: getSlidesService(authClient!),
        calendar: getCalendarService(authClient!),
        gmail: getGmailService(authClient!),
        people: getPeopleService(authClient!),
        context,
      };
    }

    // Inject From header for email tools when workspace has a senderName
    if (workspace && !mergedArgs.from && (toolName === "send_email" || toolName === "draft_email")) {
      try {
        const wsEntry = await getWorkspace(workspace);
        if (wsEntry.senderName) {
          mergedArgs.from = `${wsEntry.senderName} <${wsEntry.email}>`;
        }
      } catch {
        // Non-fatal: if workspace lookup fails here, the handler will still work without From
      }
    }

    const handler = toolRegistry[toolName];
    if (!handler) {
      return errorResponse(`Unknown tool: ${toolName}`);
    }

    return handler(services, mergedArgs);
  } catch (error: unknown) {
    // Check if it's a GoogleAuthError (already mapped)
    if (error instanceof GoogleAuthError) {
      return authErrorResponse(error);
    }

    // Check if it's a Google API error and map it
    if (isGoogleApiError(error)) {
      const authError = mapGoogleError(error);
      return authErrorResponse(authError);
    }

    // Generic error handling
    const message = error instanceof Error ? error.message : String(error);
    log("Tool error", { error: message });

    const hint = isConfigurationError(message) ? DIAGNOSTIC_HINT : "";
    return errorResponse(message + hint);
  }
});

} // end registerHandlers

// -----------------------------------------------------------------------------
// CLI HELPER FUNCTIONS
// -----------------------------------------------------------------------------

function showHelp(): void {
  const configDir = getConfigDirectory();
  console.log(`
Google Workspace MCP Server v${VERSION}

Usage:
  npx google-workspace-mcp [command] [options]

Commands:
  auth            Run the authentication flow (legacy single-account)
  auth --workspace <name>  Authenticate a workspace from workspaces.json
  workspaces      List configured workspaces
  start           Start the MCP server (default)
  version         Show version information
  help            Show this help message

Options:
  --workspace <name>         Target workspace for auth
  --profile <name>           Use a named profile (legacy single-account mode)
  --token-path <path>        Save tokens to custom path (overrides profile)

Multi-Workspace Setup (recommended):
  1. Create workspaces.json (up to 5 workspaces):
     ${process.env.GWS_WORKSPACES_CONFIG || "/opt/mcp/gws/credentials/workspaces.json"}
  2. Auth each workspace:
     npx google-workspace-mcp auth --workspace personal
     npx google-workspace-mcp auth --workspace business
  3. Gmail tools require a "workspace" parameter in every call

Legacy Single-Account Setup:
  Credentials: ${configDir}/credentials.json
  Tokens:      ${configDir}/tokens.json

Environment Variables:
  GWS_WORKSPACES_CONFIG          Path to workspaces.json (multi-workspace mode)
  GWS_MCP_PORT                   HTTP transport port (default: stdio only)
  GWS_MCP_HOST                   HTTP transport bind address (default: 127.0.0.1)
  GOOGLE_CLIENT_ID               OAuth Client ID (legacy single-account)
  GOOGLE_CLIENT_SECRET           OAuth Client Secret (legacy single-account)
  GOOGLE_WORKSPACE_MCP_PROFILE   Named profile (legacy single-account)
  GOOGLE_WORKSPACE_READ_ONLY     Restrict to read-only operations (true/false)

Examples:
  npx google-workspace-mcp auth --workspace personal
  npx google-workspace-mcp workspaces
  npx google-workspace-mcp start
  npx google-workspace-mcp
`);
}

function showVersion(): void {
  console.log(`Google Workspace MCP Server v${VERSION}`);
}

async function runAuthServer(tokenPath?: string): Promise<void> {
  try {
    // Set env vars from CLI flags (CLI takes precedence over existing env vars)
    if (tokenPath) {
      process.env.GOOGLE_WORKSPACE_MCP_TOKEN_PATH = tokenPath;
    }

    // Initialize OAuth client
    const oauth2Client = await initializeOAuth2Client();

    // Create and start auth server
    const authServer = new AuthServer(oauth2Client);
    await authServer.start();

    // Wait for completion
    const checkInterval = setInterval(() => {
      if (authServer.authCompletedSuccessfully) {
        clearInterval(checkInterval);
        process.exit(0);
      }
    }, 1000);
  } catch (error) {
    log("Authentication failed", error);
    process.exit(1);
  }
}

async function runWorkspaceAuth(workspaceName: string): Promise<void> {
  try {
    const entry = await getWorkspace(workspaceName);
    console.log(`Authenticating workspace "${workspaceName}" (${entry.email})...`);
    console.log(`  Credentials: ${entry.clientCredentials}`);
    console.log(`  Token path:  ${entry.tokenPath}`);

    // Read credentials from workspace config
    const credContent = await import("fs").then((m) =>
      m.promises.readFile(entry.clientCredentials, "utf-8"),
    );
    const { parseCredentialsFile } = await import("./types/credentials.js");
    const keys = parseCredentialsFile(credContent);

    const source = keys.installed || keys.web;
    const clientId = source?.client_id || keys.client_id;
    const clientSecret = source?.client_secret || keys.client_secret;
    const redirectUris = source?.redirect_uris || keys.redirect_uris;

    if (!clientId) {
      throw new Error(`No client_id found in ${entry.clientCredentials}`);
    }

    const { OAuth2Client } = await import("google-auth-library");
    const oauth2Client = new OAuth2Client({
      clientId,
      clientSecret: clientSecret || undefined,
      redirectUri: redirectUris?.[0] || "http://127.0.0.1/oauth2callback",
    });

    // Point token storage at workspace token path
    process.env.GOOGLE_WORKSPACE_MCP_TOKEN_PATH = entry.tokenPath;

    const authServer = new AuthServer(oauth2Client);
    await authServer.start();

    const checkInterval = setInterval(() => {
      if (authServer.authCompletedSuccessfully) {
        clearInterval(checkInterval);
        console.log(`\nWorkspace "${workspaceName}" authenticated successfully.`);
        process.exit(0);
      }
    }, 1000);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Authentication failed for workspace "${workspaceName}": ${msg}`);
    process.exit(1);
  }
}

async function listWorkspaces(): Promise<void> {
  try {
    const config = await loadWorkspacesConfig();
    console.log(`\nConfigured workspaces (${config.size}):\n`);
    for (const [name, entry] of config) {
      console.log(`  ${name}`);
      console.log(`    Email:       ${entry.email}`);
      console.log(`    Credentials: ${entry.clientCredentials}`);
      console.log(`    Tokens:      ${entry.tokenPath}`);
      console.log();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load workspaces: ${msg}`);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// MAIN EXECUTION
// -----------------------------------------------------------------------------

interface CliArgs {
  command: string | undefined;
  tokenPath?: string;
  profile?: string;
  workspace?: string;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  let command: string | undefined;
  let tokenPath: string | undefined;
  let profile: string | undefined;
  let workspace: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Handle --token-path flag
    if (arg === "--token-path" && i + 1 < args.length) {
      tokenPath = args[++i];
      continue;
    }

    // Handle --profile flag
    if (arg === "--profile" && i + 1 < args.length) {
      profile = args[++i];
      continue;
    }

    // Handle --workspace flag
    if (arg === "--workspace" && i + 1 < args.length) {
      workspace = args[++i];
      continue;
    }

    // Handle special version/help flags as commands
    if (arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h") {
      command = arg;
      continue;
    }

    // Check for command (first non-option argument)
    if (!command && !arg.startsWith("--")) {
      command = arg;
      continue;
    }
  }

  return { command, tokenPath, profile, workspace };
}

async function main() {
  const { command, tokenPath, profile, workspace } = parseCliArgs();

  // Set profile env var early so all path resolution sees it
  if (profile) {
    process.env.GOOGLE_WORKSPACE_MCP_PROFILE = profile;
  }

  switch (command) {
    case "auth":
      if (workspace) {
        await runWorkspaceAuth(workspace);
      } else {
        await runAuthServer(tokenPath);
      }
      break;
    case "workspaces":
      await listWorkspaces();
      break;
    case "start":
    case undefined:
      try {
        log("Starting Google Workspace MCP server...");

        const httpPort = process.env.GWS_MCP_PORT
          ? parseInt(process.env.GWS_MCP_PORT, 10)
          : undefined;
        const httpHost = process.env.GWS_MCP_HOST || "127.0.0.1";

        if (httpPort) {
          // Multi-session HTTP: each client gets its own Server + Transport pair
          // URL path determines default workspace: /mcp/personal → workspace "personal"
          const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

          const httpServer = createHttpServer(async (req, res) => {
            const sessionId = req.headers["mcp-session-id"] as string | undefined;

            if (sessionId && sessions.has(sessionId)) {
              // Route to existing session
              const session = sessions.get(sessionId)!;
              await session.transport.handleRequest(req, res);
              return;
            }

            // Parse workspace from URL path: /mcp/<workspace> → workspace name
            const urlPath = req.url || "/mcp";
            const pathMatch = urlPath.match(/^\/mcp\/([a-zA-Z0-9_-]+)/);
            const pathWorkspace = pathMatch?.[1];

            // New session: create a fresh Server + Transport pair
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
            });
            const sessionServer = createMcpServer(pathWorkspace);
            await sessionServer.connect(transport);

            if (pathWorkspace) {
              log("New session with path-based workspace", { workspace: pathWorkspace });
            }

            // Handle the initialize request (this assigns the session ID)
            await transport.handleRequest(req, res);

            // Register the session so subsequent requests are routed correctly
            const newSessionId = transport.sessionId;
            if (newSessionId) {
              sessions.set(newSessionId, { server: sessionServer, transport });

              // Clean up on session close
              transport.onclose = () => {
                sessions.delete(newSessionId);
                log("Session closed", { sessionId: newSessionId, activeSessions: sessions.size });
              };
            }
          });

          httpServer.listen(httpPort, httpHost, () => {
            log(`HTTP transport listening on ${httpHost}:${httpPort} (multi-session)`);
          });

          // Graceful shutdown closes all sessions
          const shutdown = async () => {
            httpServer.close();
            for (const [id, session] of sessions) {
              await session.server.close();
              sessions.delete(id);
            }
            process.exit(0);
          };
          process.on("SIGINT", shutdown);
          process.on("SIGTERM", shutdown);
        } else {
          // Stdio transport for local development
          server = createMcpServer();
          const transport = new StdioServerTransport();
          await server.connect(transport);

          process.on("SIGINT", async () => {
            await server.close();
            process.exit(0);
          });
          process.on("SIGTERM", async () => {
            await server.close();
            process.exit(0);
          });
        }

        // Enhanced startup logging
        const enabledServices = Array.from(getEnabledServices());
        const configDir = getConfigDirectory();
        log("Server started", {
          version: VERSION,
          node: process.version,
          transport: httpPort ? `http://${httpHost}:${httpPort}` : "stdio",
          profile: getActiveProfile(),
          services: enabledServices,
          read_only: isReadOnlyMode(),
          config_dir: configDir,
          token_path: getSecureTokenPath(),
        });

        // Log OAuth config status (warning if missing)
        if (getEnvVarCredentials()) {
          log("Using credentials from GOOGLE_CLIENT_ID env var");
        } else {
          const credPath = getKeysFilePath();
          try {
            await import("fs").then((m) => m.promises.access(credPath));
          } catch {
            log("Warning: OAuth credentials not configured", {
              hint:
                "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars " +
                `or save credentials to ${credPath}`,
              credentials_path: credPath,
            });
          }
        }
      } catch (error) {
        log("Failed to start server", error);
        process.exit(1);
      }
      break;
    case "version":
    case "--version":
    case "-v":
      showVersion();
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

// Export server and main for testing or potential programmatic use
export { main, server };

// Run the CLI
main().catch((error) => {
  log("Fatal error", error);
  process.exit(1);
});
