/**
 * Asana REST API client.
 *
 * Thin wrapper over https://app.asana.com/api/1.0/ using fetch().
 * All methods require a valid access token from asana-auth.
 */
import type { ExtensionContext, ExtensionAPI } from "../../../shared/extension-types";
import { getAsanaAccessToken } from "./asana-auth";

const BASE_URL = "https://app.asana.com/api/1.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AsanaWorkspace {
  gid: string;
  name: string;
}

export interface AsanaProject {
  gid: string;
  name: string;
  color: string | null;
}

export interface AsanaUser {
  gid: string;
  name: string;
  email: string;
}

export interface AsanaTask {
  gid: string;
  name: string;
  notes: string;
  due_on: string | null;
  completed: boolean;
  permalink_url: string;
}

export interface AsanaUserTaskList {
  gid: string;
  name: string;
}

export interface CreateTaskParams {
  name: string;
  notes: string;
  dueOn: string | null;
  /** Project GID, or a user_task_list GID prefixed with "utl:" */
  projectGid: string;
  workspaceGid: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createAsanaClient(context: ExtensionContext, api: ExtensionAPI) {
  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await getAsanaAccessToken(context);
    if (!token) {
      api.emitAuthRequired("Asana authentication required");
      throw new Error("Not authenticated with Asana");
    }

    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (response.status === 401) {
      api.emitAuthRequired("Asana session expired. Please reconnect.");
      throw new Error("Asana authentication expired");
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Asana API error (${response.status}): ${text}`);
    }

    const json = (await response.json()) as { data: T };
    return json.data;
  }

  return {
    async getMe(): Promise<AsanaUser> {
      return request<AsanaUser>("/users/me?opt_fields=name,email");
    },

    async getWorkspaces(): Promise<AsanaWorkspace[]> {
      return request<AsanaWorkspace[]>("/workspaces?opt_fields=name");
    },

    async getProjects(workspaceGid: string): Promise<AsanaProject[]> {
      return request<AsanaProject[]>(
        `/projects?workspace=${encodeURIComponent(workspaceGid)}&opt_fields=name,color&limit=100`,
      );
    },

    async getUserTaskList(workspaceGid: string): Promise<AsanaUserTaskList> {
      const me = await request<AsanaUser>("/users/me?opt_fields=gid");
      return request<AsanaUserTaskList>(
        `/users/${me.gid}/user_task_list?workspace=${encodeURIComponent(workspaceGid)}&opt_fields=name`,
      );
    },

    async getTask(gid: string): Promise<AsanaTask> {
      return request<AsanaTask>(
        `/tasks/${encodeURIComponent(gid)}?opt_fields=name,notes,due_on,completed,permalink_url`,
      );
    },

    async createTask(params: CreateTaskParams): Promise<AsanaTask> {
      const isUserTaskList = params.projectGid.startsWith("utl:");
      const taskListGid = isUserTaskList ? params.projectGid.slice(4) : null;

      const data: Record<string, unknown> = {
        name: params.name,
        notes: params.notes,
        due_on: params.dueOn,
        workspace: params.workspaceGid,
      };

      if (isUserTaskList) {
        // Add to user's personal task list (My Tasks)
        data.assignee = "me";
      } else {
        data.projects = [params.projectGid];
      }

      const task = await request<AsanaTask>("/tasks", {
        method: "POST",
        body: JSON.stringify({ data }),
      });

      // If adding to user task list, also add it to that list explicitly
      if (isUserTaskList && taskListGid) {
        await request(`/user_task_lists/${taskListGid}/tasks`, {
          method: "POST",
          body: JSON.stringify({ data: { task: task.gid } }),
        }).catch(() => {
          // Task is already assigned to "me", so it appears in My Tasks anyway
        });
      }

      return task;
    },
  };
}

export type AsanaClient = ReturnType<typeof createAsanaClient>;
