/**
 * Asana authentication module.
 *
 * Uses a Personal Access Token (PAT) stored via extension secrets.
 * PATs don't expire and avoid OAuth scope configuration issues.
 *
 * To get a PAT: https://app.asana.com/0/my-apps → "Create new token"
 */
import type { ExtensionContext } from "../../../shared/extension-types";

const KEY_ACCESS_TOKEN = "asana_access_token";

/**
 * Store a PAT for Asana access.
 */
export async function setAsanaToken(context: ExtensionContext, token: string): Promise<void> {
  await context.secrets.set(KEY_ACCESS_TOKEN, token);
  context.logger.info("Asana PAT stored");
}

/**
 * Check if we have an Asana token stored.
 */
export async function hasValidAsanaToken(context: ExtensionContext): Promise<boolean> {
  const token = await context.secrets.get(KEY_ACCESS_TOKEN);
  return !!token;
}

/**
 * Get the stored Asana access token, or null if not set.
 */
export async function getAsanaAccessToken(context: ExtensionContext): Promise<string | null> {
  return context.secrets.get(KEY_ACCESS_TOKEN);
}
