import { z } from "zod";

/**
 * Schema for get_status tool - returns full health, auth, and diagnostics.
 *
 * `workspace` is optional. When provided (or injected from a path-based
 * URL), the diagnostic checks resolve the per-workspace tokenPath and
 * clientCredentials from workspaces.json instead of the global XDG paths.
 */
export const GetStatusSchema = z.object({
  workspace: z.string().optional(),
});

export type GetStatusInput = z.infer<typeof GetStatusSchema>;
