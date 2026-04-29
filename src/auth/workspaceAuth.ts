import { OAuth2Client } from "google-auth-library";
import * as fs from "fs/promises";
import { google } from "googleapis";
import type {
  drive_v3,
  docs_v1,
  sheets_v4,
  slides_v1,
  calendar_v3,
  gmail_v1,
  people_v1,
} from "googleapis";
import { TokenManager } from "./tokenManager.js";
import { log } from "../utils/logging.js";
import { getWorkspace, type WorkspaceEntry } from "../config/workspaces.js";
import { parseCredentialsFile } from "../types/credentials.js";

interface CachedWorkspaceAuth {
  authClient: OAuth2Client;
  tokenManager: TokenManager;
  drive: drive_v3.Drive;
  docs: docs_v1.Docs;
  sheets: sheets_v4.Sheets;
  slides: slides_v1.Slides;
  calendar: calendar_v3.Calendar;
  gmail: gmail_v1.Gmail;
  people: people_v1.People;
}

export interface WorkspaceServices {
  drive: drive_v3.Drive;
  docs: docs_v1.Docs;
  sheets: sheets_v4.Sheets;
  slides: slides_v1.Slides;
  calendar: calendar_v3.Calendar;
  gmail: gmail_v1.Gmail;
  people: people_v1.People;
  authClient: OAuth2Client;
}

const workspaceCache = new Map<string, CachedWorkspaceAuth>();
const authInProgress = new Map<string, Promise<CachedWorkspaceAuth>>();

async function loadClientCredentials(entry: WorkspaceEntry): Promise<{
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
}> {
  const content = await fs.readFile(entry.clientCredentials, "utf-8");
  const keys = parseCredentialsFile(content);

  const source = keys.installed || keys.web;
  if (source?.client_id) {
    return {
      client_id: source.client_id,
      client_secret: source.client_secret,
      redirect_uris: source.redirect_uris,
    };
  }

  if (keys.client_id) {
    return {
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      redirect_uris: keys.redirect_uris || ["http://127.0.0.1/oauth2callback"],
    };
  }

  throw new Error(
    `Invalid credentials format in ${entry.clientCredentials}. ` +
      "Expected {installed: {...}}, {web: {...}}, or {client_id: ...}",
  );
}

async function initWorkspace(name: string): Promise<CachedWorkspaceAuth> {
  const entry = await getWorkspace(name);
  log(`Initializing workspace "${name}" (${entry.email})`);

  const creds = await loadClientCredentials(entry);
  const authClient = new OAuth2Client({
    clientId: creds.client_id,
    clientSecret: creds.client_secret || undefined,
    redirectUri: creds.redirect_uris?.[0] || "http://127.0.0.1/oauth2callback",
  });

  const tokenManager = new TokenManager(authClient, entry.email, entry.tokenPath);
  const hasTokens = await tokenManager.validateTokens();

  if (!hasTokens) {
    throw new Error(
      `Workspace "${name}" (${entry.email}) has no valid tokens. ` +
        `Run: npx google-workspace-mcp auth --workspace ${name}`,
    );
  }

  log(`Workspace "${name}" authenticated`, { email: entry.email });

  return {
    authClient,
    tokenManager,
    drive: google.drive({ version: "v3", auth: authClient }),
    docs: google.docs({ version: "v1", auth: authClient }),
    sheets: google.sheets({ version: "v4", auth: authClient }),
    slides: google.slides({ version: "v1", auth: authClient }),
    calendar: google.calendar({ version: "v3", auth: authClient }),
    gmail: google.gmail({ version: "v1", auth: authClient }),
    people: google.people({ version: "v1", auth: authClient }),
  };
}

export async function getWorkspaceServices(workspace: string): Promise<WorkspaceServices> {
  const cached = workspaceCache.get(workspace);
  if (cached) {
    return cached;
  }

  let pending = authInProgress.get(workspace);
  if (!pending) {
    pending = initWorkspace(workspace);
    authInProgress.set(workspace, pending);
  }

  try {
    const result = await pending;
    workspaceCache.set(workspace, result);
    return result;
  } finally {
    authInProgress.delete(workspace);
  }
}

export function clearWorkspaceCache(workspace?: string): void {
  if (workspace) {
    workspaceCache.delete(workspace);
  } else {
    workspaceCache.clear();
  }
}
