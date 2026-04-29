import * as fs from "fs/promises";
import * as path from "path";
import { log } from "../utils/logging.js";

const MAX_WORKSPACES = 5;
const WORKSPACE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFAULT_CONFIG_PATH = "/opt/mcp/gws/credentials/workspaces.json";

export interface WorkspaceEntry {
  label: string;
  email: string;
  clientCredentials: string;
  tokenPath: string;
  senderName?: string;
  signature?: string;
  signatureHtml?: string;
}

interface WorkspacesFileContent {
  [key: string]: {
    label?: string;
    email?: string;
    clientCredentials?: string;
    tokenPath?: string;
  };
}

let cachedConfig: Map<string, WorkspaceEntry> | null = null;
let cachedConfigPath: string | null = null;

function getConfigPath(): string {
  return process.env.GWS_WORKSPACES_CONFIG || DEFAULT_CONFIG_PATH;
}

function validateWorkspaceName(name: string): void {
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid workspace name "${name}". ` +
        "Must start with a letter, 1-32 chars: lowercase letters, digits, hyphens, underscores.",
    );
  }
}

function validateEntry(name: string, raw: Record<string, unknown>): WorkspaceEntry {
  const label = typeof raw.label === "string" ? raw.label : name;
  const email = raw.email;
  const clientCredentials = raw.clientCredentials;
  const tokenPath = raw.tokenPath;
  const senderName = typeof raw.senderName === "string" ? raw.senderName : undefined;
  const signature = typeof raw.signature === "string" ? raw.signature : undefined;
  const signatureHtml = typeof raw.signatureHtml === "string" ? raw.signatureHtml : undefined;

  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error(`Workspace "${name}": email is required and must be a valid address`);
  }
  if (typeof clientCredentials !== "string" || clientCredentials.length === 0) {
    throw new Error(`Workspace "${name}": clientCredentials path is required`);
  }
  if (typeof tokenPath !== "string" || tokenPath.length === 0) {
    throw new Error(`Workspace "${name}": tokenPath is required`);
  }

  return {
    label,
    email,
    clientCredentials: path.resolve(clientCredentials),
    tokenPath: path.resolve(tokenPath),
    senderName,
    signature,
    signatureHtml,
  };
}

export async function loadWorkspacesConfig(): Promise<Map<string, WorkspaceEntry>> {
  const configPath = getConfigPath();

  if (cachedConfig && cachedConfigPath === configPath) {
    return cachedConfig;
  }

  let content: string;
  try {
    content = await fs.readFile(configPath, "utf-8");
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      throw new Error(
        `Workspaces config not found at ${configPath}. ` +
          "Set GWS_WORKSPACES_CONFIG or create the file. " +
          "See planning/customization-plan.md for the expected format.",
      );
    }
    throw new Error(`Failed to read workspaces config: ${(error as Error).message}`);
  }

  let parsed: WorkspacesFileContent;
  try {
    parsed = JSON.parse(content) as WorkspacesFileContent;
  } catch {
    throw new Error(`Invalid JSON in workspaces config at ${configPath}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Workspaces config must be a JSON object with workspace entries");
  }

  const names = Object.keys(parsed);
  if (names.length === 0) {
    throw new Error("Workspaces config has no workspace entries");
  }
  if (names.length > MAX_WORKSPACES) {
    throw new Error(`Too many workspaces (${names.length}). Maximum is ${MAX_WORKSPACES}.`);
  }

  const result = new Map<string, WorkspaceEntry>();
  for (const name of names) {
    validateWorkspaceName(name);
    const entry = validateEntry(name, parsed[name] as Record<string, unknown>);
    result.set(name, entry);
  }

  cachedConfig = result;
  cachedConfigPath = configPath;
  log("Loaded workspaces config", {
    path: configPath,
    workspaces: names,
  });

  return result;
}

export async function getWorkspace(name: string): Promise<WorkspaceEntry> {
  const config = await loadWorkspacesConfig();
  const entry = config.get(name);
  if (!entry) {
    const available = Array.from(config.keys());
    throw new Error(`Unknown workspace "${name}". Available: ${available.join(", ")}`);
  }
  return entry;
}

export async function getWorkspaceNames(): Promise<string[]> {
  const config = await loadWorkspacesConfig();
  return Array.from(config.keys());
}

export function resetWorkspacesCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
}

export async function saveWorkspacesConfig(workspaces: Map<string, WorkspaceEntry>): Promise<void> {
  if (workspaces.size > MAX_WORKSPACES) {
    throw new Error(`Too many workspaces (${workspaces.size}). Maximum is ${MAX_WORKSPACES}.`);
  }

  const configPath = getConfigPath();
  const obj: Record<string, WorkspaceEntry> = {};
  for (const [name, entry] of workspaces) {
    validateWorkspaceName(name);
    obj[name] = entry;
  }

  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });

  cachedConfig = workspaces;
  cachedConfigPath = configPath;
  log("Saved workspaces config", { path: configPath });
}
