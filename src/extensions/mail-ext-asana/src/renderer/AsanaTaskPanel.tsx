import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DashboardEmail } from "../../../../shared/types";
import type { ExtensionEnrichmentResult } from "../../../../shared/extension-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AsanaTaskPanelProps {
  email: DashboardEmail;
  threadEmails: DashboardEmail[];
  enrichment: ExtensionEnrichmentResult | null;
  isLoading: boolean;
}

interface SuggestedTask {
  title: string;
  description: string;
  suggestedDueDate: string | null;
}

interface AsanaProject {
  gid: string;
  name: string;
}

interface AsanaWorkspace {
  gid: string;
  name: string;
}

interface LinkedTaskInfo {
  gid: string;
  name: string;
  permalink: string;
  completed: boolean | null; // null if task was deleted or fetch failed
}

type TaskStatus = "pending" | "creating" | "created" | "error";

interface TaskCardState {
  task: SuggestedTask;
  status: TaskStatus;
  editedTitle: string;
  editedDescription: string;
  editedDueDate: string;
  permalink: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

interface AsanaApi {
  suggestTasks: (params: {
    emailId: string;
    subject: string;
    from: string;
    to: string;
    body: string;
    threadContext: string;
    userContext?: string;
  }) => Promise<{ tasks: SuggestedTask[] }>;
  createTask: (params: {
    name: string;
    notes: string;
    dueOn: string | null;
    projectGid: string;
    workspaceGid: string;
  }) => Promise<{ success: boolean; task: { gid: string; permalink_url: string } }>;
  getWorkspaces: () => Promise<{ workspaces: AsanaWorkspace[] }>;
  getProjects: (params: { workspaceGid: string }) => Promise<{ projects: AsanaProject[] }>;
  getUserTaskList: (params: {
    workspaceGid: string;
  }) => Promise<{ taskList: { gid: string; name: string } }>;
  checkAuth: () => Promise<{ authenticated: boolean }>;
  saveToken: (params: { token: string }) => Promise<{ success: boolean }>;
  getLinkedTasks: (params: {
    threadId: string;
  }) => Promise<{ tasks: LinkedTaskInfo[] }>;
  linkTask: (params: {
    threadId: string;
    gid: string;
    name: string;
    permalink: string;
  }) => Promise<{ success: boolean }>;
  getDraftTasks: (params: {
    threadId: string;
  }) => Promise<{ drafts: Array<{ title: string; description: string; dueDate: string }> }>;
  saveDraftTasks: (params: {
    threadId: string;
    drafts: Array<{ title: string; description: string; dueDate: string }>;
  }) => Promise<{ success: boolean }>;
}

function getAsanaApi(): AsanaApi {
  return (window as unknown as { api: { asana: AsanaApi } }).api.asana;
}

interface ExtensionsApi {
  getSetting: (extensionId: string, key: string) => Promise<{ success: boolean; data?: unknown }>;
  setSetting: (extensionId: string, key: string, value: unknown) => Promise<unknown>;
}

function getExtensionsApi(): ExtensionsApi {
  return (window as unknown as { api: { extensions: ExtensionsApi } }).api.extensions;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className || "w-4 h-4"}`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="w-4 h-4 text-green-500"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function TaskCard({
  cardState,
  onUpdate,
  onAddToAsana,
  onDismiss,
}: {
  cardState: TaskCardState;
  onUpdate: (updates: Partial<TaskCardState>) => void;
  onAddToAsana: () => void;
  onDismiss: () => void;
}) {
  const { status, editedTitle, editedDescription, editedDueDate, permalink, error } = cardState;

  if (status === "created" && permalink) {
    return (
      <div className="border border-green-200 dark:border-green-800 rounded-lg p-3 bg-green-50 dark:bg-green-900/20">
        <div className="flex items-center gap-2 mb-1">
          <CheckIcon />
          <span className="text-sm font-medium text-green-700 dark:text-green-300">
            Task created
          </span>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400 truncate">{editedTitle}</p>
        <a
          href={permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1 inline-block"
        >
          View in Asana
        </a>
      </div>
    );
  }

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textareas to fit content using scrollHeight
  const autoResize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => autoResize(titleRef.current), [editedTitle, autoResize]);
  useEffect(() => autoResize(descRef.current), [editedDescription, autoResize]);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2">
      <div className="flex items-start gap-1">
        <textarea
          ref={titleRef}
          value={editedTitle}
          onChange={(e) => onUpdate({ editedTitle: e.target.value.replace(/\n/g, " ") })}
          className="flex-1 min-w-0 text-sm font-medium bg-transparent border-none outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400 resize-none overflow-hidden"
          placeholder="Task title"
          rows={1}
          disabled={status === "creating"}
        />
        <button
          onClick={onDismiss}
          className="flex-shrink-0 p-0.5 rounded text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors mt-0.5"
          title="Dismiss suggestion"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <textarea
        ref={descRef}
        value={editedDescription}
        onChange={(e) => onUpdate({ editedDescription: e.target.value })}
        className="w-full text-xs bg-transparent border border-gray-200 dark:border-gray-600 rounded p-1.5 outline-none text-gray-600 dark:text-gray-300 placeholder-gray-400 resize-none overflow-hidden"
        placeholder="Description"
        rows={1}
        disabled={status === "creating"}
      />
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 dark:text-gray-400">Due:</label>
        <input
          type="date"
          value={editedDueDate}
          onChange={(e) => onUpdate({ editedDueDate: e.target.value })}
          className="text-xs bg-transparent border border-gray-200 dark:border-gray-600 rounded px-1.5 py-0.5 outline-none text-gray-700 dark:text-gray-300"
          disabled={status === "creating"}
        />
      </div>
      {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      <button
        onClick={onAddToAsana}
        disabled={status === "creating" || !editedTitle.trim()}
        className="w-full text-xs font-medium py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white disabled:text-gray-500 dark:disabled:text-gray-400 transition-colors flex items-center justify-center gap-1.5"
      >
        {status === "creating" ? (
          <>
            <SpinnerIcon className="w-3 h-3" />
            Creating...
          </>
        ) : (
          "Add to Asana"
        )}
      </button>
    </div>
  );
}

function TokenInput({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!token.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await getAsanaApi().saveToken({ token: token.trim() });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save token");
    } finally {
      setSaving(false);
    }
  }, [token, onSaved]);

  return (
    <div className="border border-amber-200 dark:border-amber-800 rounded-lg p-3 bg-amber-50 dark:bg-amber-900/20 space-y-2">
      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
        Connect Asana to create tasks
      </p>
      <p className="text-xs text-amber-600 dark:text-amber-400">
        Create a Personal Access Token at{" "}
        <a
          href="https://app.asana.com/0/my-apps"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          app.asana.com/0/my-apps
        </a>{" "}
        and paste it below.
      </p>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Paste your Asana PAT..."
        className="w-full text-xs bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-700 rounded px-2 py-1.5 outline-none text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:border-amber-500"
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
        }}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <button
        onClick={handleSave}
        disabled={saving || !token.trim()}
        className="w-full text-xs font-medium py-1.5 rounded bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white disabled:text-gray-500 transition-colors flex items-center justify-center gap-1.5"
      >
        {saving ? (
          <>
            <SpinnerIcon className="w-3 h-3" />
            Saving...
          </>
        ) : (
          "Save Token"
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className || "w-4 h-4"}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.38.138.75.43.992l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export function AsanaTaskPanel({ email, threadEmails }: AsanaTaskPanelProps): React.ReactElement {
  const [userContext, setUserContext] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [taskCards, setTaskCards] = useState<TaskCardState[]>([]);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [systemPromptLoaded, setSystemPromptLoaded] = useState(false);
  const [linkedTasks, setLinkedTasks] = useState<LinkedTaskInfo[]>([]);
  const [linkedTasksLoading, setLinkedTasksLoading] = useState(false);

  // Asana config state
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [workspaces, setWorkspaces] = useState<AsanaWorkspace[]>([]);
  const [projects, setProjects] = useState<AsanaProject[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [selectedProject, setSelectedProject] = useState("");

  // Check auth + load system prompt on mount
  useEffect(() => {
    getAsanaApi()
      .checkAuth()
      .then(({ authenticated: auth }) => setAuthenticated(auth))
      .catch(() => setAuthenticated(false));

    getExtensionsApi()
      .getSetting("asana", "systemPrompt")
      .then((result) => {
        if (result.success && typeof result.data === "string") {
          setSystemPrompt(result.data);
        }
        setSystemPromptLoaded(true);
      })
      .catch(() => setSystemPromptLoaded(true));
  }, []);

  // Load saved defaults + workspaces when authenticated
  useEffect(() => {
    if (!authenticated) return;
    const ext = getExtensionsApi();
    Promise.all([
      ext.getSetting("asana", "defaultWorkspaceGid"),
      ext.getSetting("asana", "defaultProjectGid"),
      getAsanaApi().getWorkspaces(),
    ])
      .then(([wsResult, projResult, { workspaces: ws }]) => {
        const savedWorkspace = wsResult.success ? (wsResult.data as string) : "";
        const savedProject = projResult.success ? (projResult.data as string) : "";

        setWorkspaces(ws);

        // Use saved default, or auto-select if only one workspace
        const wsToSelect = savedWorkspace && ws.some((w) => w.gid === savedWorkspace)
          ? savedWorkspace
          : ws.length === 1
            ? ws[0].gid
            : "";
        setSelectedWorkspace(wsToSelect);

        // Project will be loaded by the workspace effect below,
        // but stash the saved project so it can be restored
        if (savedProject) setSelectedProject(savedProject);
      })
      .catch((err) => console.error("[AsanaTaskPanel] Failed to load workspaces:", err));
  }, [authenticated]);

  // Load projects + personal task list when workspace selected
  useEffect(() => {
    if (!selectedWorkspace) {
      setProjects([]);
      return;
    }
    const savedProject = selectedProject; // capture before async
    const api = getAsanaApi();
    Promise.all([
      api.getUserTaskList({ workspaceGid: selectedWorkspace }),
      api.getProjects({ workspaceGid: selectedWorkspace }),
    ])
      .then(([{ taskList }, { projects: ps }]) => {
        // Prepend "My Tasks" with utl: prefix so createTask knows it's a user task list
        const myTasks: AsanaProject = {
          gid: `utl:${taskList.gid}`,
          name: "My Tasks",
          color: null,
        };
        const allOptions = [myTasks, ...ps];
        setProjects(allOptions);
        // Restore saved project if it exists, otherwise default to My Tasks
        const match = savedProject && allOptions.some((p) => p.gid === savedProject);
        if (!match) setSelectedProject(myTasks.gid);
      })
      .catch((err) => console.error("[AsanaTaskPanel] Failed to load projects:", err));
  }, [selectedWorkspace]);

  // Persist draft tasks to storage
  const saveDrafts = useCallback(
    (cards: TaskCardState[]) => {
      const pending = cards
        .filter((c) => c.status === "pending")
        .map((c) => ({
          title: c.editedTitle,
          description: c.editedDescription,
          dueDate: c.editedDueDate,
        }));
      getAsanaApi().saveDraftTasks({ threadId: email.threadId, drafts: pending });
    },
    [email.threadId],
  );

  // Reset state and load linked + draft tasks when email changes
  useEffect(() => {
    setAnalyzeError(null);
    setUserContext("");

    const api = getAsanaApi();

    // Load linked tasks
    setLinkedTasksLoading(true);
    api
      .getLinkedTasks({ threadId: email.threadId })
      .then(({ tasks }) => setLinkedTasks(tasks))
      .catch(() => setLinkedTasks([]))
      .finally(() => setLinkedTasksLoading(false));

    // Load persisted draft tasks
    api
      .getDraftTasks({ threadId: email.threadId })
      .then(({ drafts }) => {
        if (drafts.length > 0) {
          setTaskCards(
            drafts.map((d) => ({
              task: { title: d.title, description: d.description, suggestedDueDate: d.dueDate || null },
              status: "pending" as const,
              editedTitle: d.title,
              editedDescription: d.description,
              editedDueDate: d.dueDate,
              permalink: null,
              error: null,
            })),
          );
          setHasAnalyzed(true);
        } else {
          setTaskCards([]);
          setHasAnalyzed(false);
        }
      })
      .catch(() => {
        setTaskCards([]);
        setHasAnalyzed(false);
      });
  }, [email.id, email.threadId]);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const threadContext = threadEmails
        .filter((e) => e.id !== email.id)
        .map((e) => `From: ${e.from}\nSubject: ${e.subject}\n${e.body || e.snippet || ""}`)
        .join("\n---\n");

      const result = await getAsanaApi().suggestTasks({
        emailId: email.id,
        subject: email.subject,
        from: email.from,
        to: email.to,
        body: email.body || email.snippet || "",
        threadContext,
        userContext: userContext.trim() || undefined,
      });

      const newCards = result.tasks.map((task) => ({
        task,
        status: "pending" as const,
        editedTitle: task.title,
        editedDescription: task.description,
        editedDueDate: task.suggestedDueDate || "",
        permalink: null,
        error: null,
      }));
      setTaskCards(newCards);
      setHasAnalyzed(true);
      saveDrafts(newCards);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Failed to analyze email");
    } finally {
      setAnalyzing(false);
    }
  }, [email, threadEmails, userContext, saveDrafts]);

  const handleAddToAsana = useCallback(
    async (index: number) => {
      if (!selectedWorkspace || !selectedProject) return;

      setTaskCards((prev) =>
        prev.map((c, i) => (i === index ? { ...c, status: "creating" as const, error: null } : c)),
      );

      try {
        const card = taskCards[index];
        const result = await getAsanaApi().createTask({
          name: card.editedTitle,
          notes: card.editedDescription,
          dueOn: card.editedDueDate || null,
          projectGid: selectedProject,
          workspaceGid: selectedWorkspace,
        });

        const permalink = result.task.permalink_url;
        setTaskCards((prev) => {
          const updated = prev.map((c, i) =>
            i === index ? { ...c, status: "created" as const, permalink } : c,
          );
          // Persist remaining pending drafts (created ones are filtered out)
          saveDrafts(updated);
          return updated;
        });

        // Link task to this thread for persistence
        const api = getAsanaApi();
        await api.linkTask({
          threadId: email.threadId,
          gid: result.task.gid,
          name: card.editedTitle,
          permalink,
        });
        // Update linked tasks list to show immediately
        setLinkedTasks((prev) => [
          ...prev,
          { gid: result.task.gid, name: card.editedTitle, permalink, completed: false },
        ]);
      } catch (err) {
        setTaskCards((prev) =>
          prev.map((c, i) =>
            i === index
              ? {
                  ...c,
                  status: "error" as const,
                  error: err instanceof Error ? err.message : "Failed to create task",
                }
              : c,
          ),
        );
      }
    },
    [taskCards, selectedWorkspace, selectedProject, email.threadId, saveDrafts],
  );

  const updateCard = useCallback(
    (index: number, updates: Partial<TaskCardState>) => {
      setTaskCards((prev) => {
        const updated = prev.map((c, i) => (i === index ? { ...c, ...updates } : c));
        saveDrafts(updated);
        return updated;
      });
    },
    [saveDrafts],
  );

  const dismissCard = useCallback(
    (index: number) => {
      setTaskCards((prev) => {
        const updated = prev.filter((_, i) => i !== index);
        saveDrafts(updated);
        return updated;
      });
    },
    [saveDrafts],
  );

  // --- Render ---

  const handleSavePrompt = useCallback(
    (value: string) => {
      setSystemPrompt(value);
      getExtensionsApi().setSetting("asana", "systemPrompt", value);
    },
    [],
  );

  return (
    <div className="p-3 space-y-3 overflow-hidden">
      {/* Header with settings gear */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => setShowSettings((prev) => !prev)}
          className={`p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
            showSettings
              ? "text-purple-600 dark:text-purple-400"
              : "text-gray-400 dark:text-gray-500"
          }`}
          title="Task extraction settings"
        >
          <GearIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Settings panel (collapsible) */}
      {showSettings && systemPromptLoaded && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2 bg-gray-50 dark:bg-gray-800/50">
          <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Task extraction prompt
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Custom system prompt for AI task extraction. Leave blank to use the default.
          </p>
          <textarea
            value={systemPrompt}
            onChange={(e) => handleSavePrompt(e.target.value)}
            placeholder="You are an executive assistant analyzing emails to identify actionable tasks..."
            className="w-full text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded p-2 outline-none text-gray-700 dark:text-gray-300 placeholder-gray-400 resize-none focus:border-purple-400 dark:focus:border-purple-500 font-mono"
            rows={6}
          />
        </div>
      )}

      {/* Linked tasks from this thread */}
      {linkedTasksLoading && (
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <SpinnerIcon className="w-3 h-3" />
          Loading linked tasks...
        </div>
      )}
      {linkedTasks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Linked tasks</p>
          {linkedTasks.map((lt) => (
            <div
              key={lt.gid}
              className="flex items-center gap-2 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2"
            >
              {lt.completed === true && (
                <CheckIcon />
              )}
              {lt.completed === false && (
                <span className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-600 flex-shrink-0" />
              )}
              {lt.completed === null && (
                <span className="w-4 h-4 text-gray-400" title="Status unknown">?</span>
              )}
              <a
                href={lt.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className={`hover:underline truncate ${
                  lt.completed
                    ? "text-gray-400 dark:text-gray-500 line-through"
                    : "text-gray-700 dark:text-gray-300"
                }`}
              >
                {lt.name}
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Analyze section */}
      <div className="space-y-2">
        <textarea
          value={userContext}
          onChange={(e) => setUserContext(e.target.value)}
          placeholder="Optional: add context to guide task suggestions..."
          className="w-full text-xs bg-transparent border border-gray-200 dark:border-gray-600 rounded p-2 outline-none text-gray-700 dark:text-gray-300 placeholder-gray-400 resize-none focus:border-blue-400 dark:focus:border-blue-500"
          rows={2}
          disabled={analyzing}
        />
        <button
          onClick={handleAnalyze}
          disabled={analyzing}
          className="w-full text-xs font-medium py-2 rounded bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white disabled:text-gray-500 dark:disabled:text-gray-400 transition-colors flex items-center justify-center gap-1.5"
        >
          {analyzing ? (
            <>
              <SpinnerIcon className="w-3.5 h-3.5" />
              Analyzing...
            </>
          ) : hasAnalyzed ? (
            "Re-analyze"
          ) : (
            "Suggest Tasks"
          )}
        </button>
      </div>

      {analyzeError && <p className="text-xs text-red-500 dark:text-red-400">{analyzeError}</p>}

      {/* Results */}
      {hasAnalyzed && taskCards.length === 0 && (
        <div className="text-center py-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            No actionable tasks found in this email.
          </p>
        </div>
      )}

      {taskCards.length > 0 && (
        <div className="space-y-3">
          {/* Asana auth — PAT input */}
          {authenticated === false && (
            <TokenInput
              onSaved={() => {
                setAuthenticated(true);
              }}
            />
          )}

          {authenticated && (
            <div className="space-y-1.5">
              <select
                value={selectedWorkspace}
                onChange={(e) => {
                  const gid = e.target.value;
                  setSelectedWorkspace(gid);
                  setSelectedProject("");
                  getExtensionsApi().setSetting("asana", "defaultWorkspaceGid", gid);
                }}
                className="w-full text-xs bg-transparent border border-gray-200 dark:border-gray-600 rounded px-1.5 py-1 outline-none text-gray-700 dark:text-gray-300 truncate"
              >
                <option value="">Workspace...</option>
                {workspaces.map((w) => (
                  <option key={w.gid} value={w.gid}>
                    {w.name}
                  </option>
                ))}
              </select>
              <select
                value={selectedProject}
                onChange={(e) => {
                  const gid = e.target.value;
                  setSelectedProject(gid);
                  getExtensionsApi().setSetting("asana", "defaultProjectGid", gid);
                }}
                className="w-full text-xs bg-transparent border border-gray-200 dark:border-gray-600 rounded px-1.5 py-1 outline-none text-gray-700 dark:text-gray-300 truncate"
                disabled={!selectedWorkspace}
              >
                <option value="">Project / list...</option>
                {projects.map((p) => (
                  <option key={p.gid} value={p.gid}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Task cards */}
          {taskCards.map((cardState, index) => (
            <TaskCard
              key={index}
              cardState={cardState}
              onUpdate={(updates) => updateCard(index, updates)}
              onAddToAsana={() => handleAddToAsana(index)}
              onDismiss={() => dismissCard(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
