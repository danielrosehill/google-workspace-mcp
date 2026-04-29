import { z } from "zod";

export const WorkspaceField = z
  .string()
  .min(1)
  .max(32)
  .describe(
    "Workspace name (e.g. 'personal', 'business'). " + "Must match an entry in workspaces.json.",
  );
