/**
 * Asana Extension - Main process entry point
 *
 * Provides AI-powered task extraction from emails and Asana task creation.
 * Analysis is on-demand (user-triggered), not automatic.
 * Auth uses a Personal Access Token (PAT) — no OAuth needed.
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
import { ipcMain } from "electron";

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

let cleanupHandlers: Array<() => void> = [];

const extension: ExtensionModule = {
  async activate(context: ExtensionContext, api: ExtensionAPI): Promise<void> {
    context.logger.info("Activating Asana extension");

    const asanaClient = createAsanaClient(context, api);

    // Register auth handler — for PAT, the renderer handles the token input
    // and calls asana:save-token. The auth banner just signals that auth is needed.
    api.registerAuthHandler(
      async () => {
        // No-op: PAT entry is handled in the renderer panel
        api.emitAuthRequired("Enter your Asana Personal Access Token in the Tools sidebar");
      },
      {
        checkAuth: () => hasValidAsanaToken(context),
      },
    );

    // --- IPC Handlers ---

    const handlers: Array<{ channel: string; handler: Parameters<typeof ipcMain.handle>[1] }> = [
      {
        channel: "asana:check-auth",
        handler: async () => {
          return { authenticated: await hasValidAsanaToken(context) };
        },
      },
      {
        channel: "asana:save-token",
        handler: async (_event, params: { token: string }) => {
          await setAsanaToken(context, params.token);
          return { success: true };
        },
      },
      {
        channel: "asana:suggest-tasks",
        handler: async (_event, params: TaskExtractionInput) => {
          const customPrompt = await api.getSetting<string>("systemPrompt");
          const result = await extractTasks(params, context, customPrompt || undefined);
          return result;
        },
      },
      {
        channel: "asana:create-task",
        handler: async (_event, params: CreateTaskParams) => {
          const task = await asanaClient.createTask(params);
          return { success: true, task };
        },
      },
      {
        channel: "asana:get-workspaces",
        handler: async () => {
          const workspaces = await asanaClient.getWorkspaces();
          return { workspaces };
        },
      },
      {
        channel: "asana:get-projects",
        handler: async (_event, params: { workspaceGid: string }) => {
          const projects = await asanaClient.getProjects(params.workspaceGid);
          return { projects };
        },
      },
      {
        channel: "asana:get-user-task-list",
        handler: async (_event, params: { workspaceGid: string }) => {
          const taskList = await asanaClient.getUserTaskList(params.workspaceGid);
          return { taskList };
        },
      },
      {
        channel: "asana:get-linked-tasks",
        handler: async (_event, params: { threadId: string }) => {
          const linked =
            (await context.storage.get<LinkedTask[]>(`linked:${params.threadId}`)) ?? [];
          if (linked.length === 0) return { tasks: [] };
          // Fetch current status from Asana for each linked task
          const tasks = await Promise.all(
            linked.map(async (lt) => {
              try {
                const task = await asanaClient.getTask(lt.gid);
                return { ...lt, name: task.name, completed: task.completed };
              } catch {
                // Task may have been deleted — still show it but mark unknown
                return { ...lt, completed: null };
              }
            }),
          );
          return { tasks };
        },
      },
      {
        channel: "asana:link-task",
        handler: async (
          _event,
          params: { threadId: string; gid: string; name: string; permalink: string },
        ) => {
          const key = `linked:${params.threadId}`;
          const existing = (await context.storage.get<LinkedTask[]>(key)) ?? [];
          // Avoid duplicates
          if (existing.some((t) => t.gid === params.gid)) return { success: true };
          existing.push({ gid: params.gid, name: params.name, permalink: params.permalink });
          await context.storage.set(key, existing);
          return { success: true };
        },
      },
      {
        channel: "asana:get-draft-tasks",
        handler: async (_event, params: { threadId: string }) => {
          const drafts =
            (await context.storage.get<DraftTask[]>(`drafts:${params.threadId}`)) ?? [];
          return { drafts };
        },
      },
      {
        channel: "asana:save-draft-tasks",
        handler: async (_event, params: { threadId: string; drafts: DraftTask[] }) => {
          if (params.drafts.length === 0) {
            await context.storage.delete(`drafts:${params.threadId}`);
          } else {
            await context.storage.set(`drafts:${params.threadId}`, params.drafts);
          }
          return { success: true };
        },
      },
    ];

    for (const { channel, handler } of handlers) {
      ipcMain.handle(channel, handler);
      cleanupHandlers.push(() => ipcMain.removeHandler(channel));
    }

    context.logger.info("Asana extension activated");
  },

  async deactivate(): Promise<void> {
    for (const cleanup of cleanupHandlers) {
      cleanup();
    }
    cleanupHandlers = [];
  },
};

export const { activate, deactivate } = extension;
