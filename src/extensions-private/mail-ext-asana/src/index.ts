/**
 * Asana Extension - Main process entry point
 *
 * Provides AI-powered task extraction from emails and Asana task creation.
 * Analysis is on-demand (user-triggered), not automatic.
 * Auth uses a Personal Access Token (PAT) — no OAuth needed.
 *
 * All IPC is registered via api.registerIpcHandler() so this extension
 * works as a bundled, private, or installed (distributable) extension
 * without requiring changes to the preload script.
 */
import type {
  ExtensionModule,
  ExtensionContext,
  ExtensionAPI,
} from "../../../shared/extension-types";
import { setAsanaToken, hasValidAsanaToken } from "./asana-auth";
import { createAsanaClient } from "./asana-api-client";
import { extractTasks } from "./task-extractor";
import type { TaskExtractionInput } from "./task-extractor";
import type { CreateTaskParams } from "./asana-api-client";

interface LinkedTask {
  gid: string;
  name: string;
  permalink: string;
}

interface DraftTask {
  title: string;
  description: string;
  dueDate: string;
}

const extension: ExtensionModule = {
  async activate(context: ExtensionContext, api: ExtensionAPI): Promise<void> {
    context.logger.info("Activating Asana extension");

    const asanaClient = createAsanaClient(context, api);

    // Register auth handler — for PAT, the renderer handles the token input
    // and calls asana:save-token. The auth banner just signals that auth is needed.
    api.registerAuthHandler(
      async () => {
        // No-op: PAT entry is handled inline in the wizard or renderer panel
        api.emitAuthRequired("Enter your Asana Personal Access Token");
      },
      {
        checkAuth: () => hasValidAsanaToken(context),
        authMethod: "token",
        tokenLabel: "Personal Access Token",
        tokenPlaceholder: "0/abc123...",
        tokenHelpUrl: "https://app.asana.com/0/my-apps",
      },
    );

    // --- IPC Handlers (registered via generic extensions:invoke) ---

    api.registerIpcHandler("check-auth", async () => {
      return { authenticated: await hasValidAsanaToken(context) };
    });

    api.registerIpcHandler("save-token", async (params) => {
      const { token } = params as { token: string };
      await setAsanaToken(context, token);
      return { success: true };
    });

    api.registerIpcHandler("suggest-tasks", async (params) => {
      const input = params as TaskExtractionInput;
      const customPrompt = await api.getSetting<string>("systemPrompt");
      return extractTasks(input, context, api, customPrompt || undefined);
    });

    api.registerIpcHandler("create-task", async (params) => {
      const task = await asanaClient.createTask(params as CreateTaskParams);
      return { success: true, task };
    });

    api.registerIpcHandler("get-workspaces", async () => {
      const workspaces = await asanaClient.getWorkspaces();
      return { workspaces };
    });

    api.registerIpcHandler("get-projects", async (params) => {
      const { workspaceGid } = params as { workspaceGid: string };
      const projects = await asanaClient.getProjects(workspaceGid);
      return { projects };
    });

    api.registerIpcHandler("get-user-task-list", async (params) => {
      const { workspaceGid } = params as { workspaceGid: string };
      const taskList = await asanaClient.getUserTaskList(workspaceGid);
      return { taskList };
    });

    api.registerIpcHandler("get-linked-tasks", async (params) => {
      const { threadId } = params as { threadId: string };
      const key = `linked:${threadId}`;
      const linked = (await context.storage.get<LinkedTask[]>(key)) ?? [];
      if (linked.length === 0) return { tasks: [] };
      // Fetch current status from Asana for each linked task
      const results = await Promise.all(
        linked.map(async (lt) => {
          try {
            const task = await asanaClient.getTask(lt.gid);
            return { ...lt, name: task.name, completed: task.completed };
          } catch {
            // Task was deleted or is inaccessible — remove it
            return null;
          }
        }),
      );
      const tasks = results.filter((t) => t !== null);
      // Prune deleted tasks from storage so they don't reappear
      if (tasks.length < linked.length) {
        const remaining = linked.filter((lt) => tasks.some((t) => t.gid === lt.gid));
        if (remaining.length === 0) {
          await context.storage.delete(key);
        } else {
          await context.storage.set(key, remaining);
        }
      }
      return { tasks };
    });

    api.registerIpcHandler("link-task", async (params) => {
      const { threadId, gid, name, permalink } = params as {
        threadId: string;
        gid: string;
        name: string;
        permalink: string;
      };
      const key = `linked:${threadId}`;
      const existing = (await context.storage.get<LinkedTask[]>(key)) ?? [];
      // Avoid duplicates
      if (existing.some((t) => t.gid === gid)) return { success: true };
      existing.push({ gid, name, permalink });
      await context.storage.set(key, existing);
      return { success: true };
    });

    api.registerIpcHandler("get-draft-tasks", async (params) => {
      const { threadId } = params as { threadId: string };
      const drafts = (await context.storage.get<DraftTask[]>(`drafts:${threadId}`)) ?? [];
      return { drafts };
    });

    api.registerIpcHandler("save-draft-tasks", async (params) => {
      const { threadId, drafts } = params as { threadId: string; drafts: DraftTask[] };
      if (drafts.length === 0) {
        await context.storage.delete(`drafts:${threadId}`);
      } else {
        await context.storage.set(`drafts:${threadId}`, drafts);
      }
      return { success: true };
    });

    context.logger.info("Asana extension activated");
  },
};

export const { activate, deactivate } = extension;
