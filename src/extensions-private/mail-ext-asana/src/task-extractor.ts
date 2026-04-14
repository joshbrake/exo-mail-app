/**
 * AI-powered task extraction from email content.
 *
 * Uses Claude (Haiku 4.5) to analyze an email and suggest 0-3 actionable
 * Asana tasks with title, description, and suggested due date.
 * Triggered on-demand by the user, not automatically.
 *
 * Uses ExtensionAPI.ai.createMessage() so this works as a distributable
 * extension without importing internal services.
 */
import type { ExtensionContext, ExtensionAPI } from "../../../shared/extension-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuggestedTask {
  title: string;
  description: string;
  suggestedDueDate: string | null; // YYYY-MM-DD or null
}

export interface TaskExtractionResult {
  tasks: SuggestedTask[];
}

export interface TaskExtractionInput {
  emailId: string;
  subject: string;
  from: string;
  to: string;
  body: string;
  threadContext: string; // Concatenated prior messages for context
  userContext?: string; // Optional user-provided guidance
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const JSON_SCHEMA_SUFFIX = `

Respond ONLY with valid JSON matching this schema:
{
  "tasks": [
    {
      "title": "string",
      "description": "string",
      "suggestedDueDate": "YYYY-MM-DD or null"
    }
  ]
}`;

const DEFAULT_SYSTEM_PROMPT = `Analyze the email thread and generate a set of tasks for the recipient based on the contents. Assign due dates where relevant. Include links to content in the task description wherever possible and include any relevant context from the emails so that the task contains all the context needed to complete the task.

Rules:
- Task titles should be concise imperative phrases (e.g., "Review Q3 budget proposal", "Schedule meeting with design team")
- Task descriptions should be comprehensive — include key details, deadlines, people involved, and any links or references from the email so the task is self-contained
- Suggest a due date (YYYY-MM-DD format) when the email mentions a deadline, timeline, or when urgency is implied. Use null if no date is relevant.
- Do NOT suggest tasks for: newsletters, marketing emails, automated notifications, receipts, or purely informational messages
- If the user provides additional context, use it to guide your task extraction
- Return an empty tasks array if there are no actionable items`;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export async function extractTasks(
  input: TaskExtractionInput,
  context: ExtensionContext,
  api: ExtensionAPI,
  customSystemPrompt?: string,
): Promise<TaskExtractionResult> {
  context.logger.info("Extracting tasks from email", input.emailId);

  const today = new Date().toISOString().split("T")[0];

  let userMessage = `Today's date: ${today}

Email subject: ${input.subject}
From: ${input.from}
To: ${input.to}

Email body:
${input.body}`;

  if (input.threadContext) {
    userMessage += `\n\nPrior messages in thread:\n${input.threadContext}`;
  }

  if (input.userContext) {
    userMessage += `\n\nAdditional context from user:\n${input.userContext}`;
  }

  const basePrompt = customSystemPrompt
    ? `${DEFAULT_SYSTEM_PROMPT}\n\nAdditional instructions:\n${customSystemPrompt}`
    : DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = basePrompt + JSON_SCHEMA_SUFFIX;

  const response = await api.ai.createMessage({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  // Extract text content from response
  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    context.logger.warn("No text content in task extraction response");
    return { tasks: [] };
  }

  try {
    // Strip markdown code fences if present (e.g. ```json ... ```)
    let jsonText = (textBlock as { type: "text"; text: string }).text.trim();
    const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) {
      jsonText = fenceMatch[1].trim();
    }
    const parsed = JSON.parse(jsonText) as TaskExtractionResult;
    if (!Array.isArray(parsed.tasks)) {
      context.logger.warn("Invalid task extraction response structure");
      return { tasks: [] };
    }
    // Validate and sanitize each task
    const tasks = parsed.tasks
      .slice(0, 3)
      .filter(
        (t): t is SuggestedTask =>
          typeof t.title === "string" && typeof t.description === "string" && t.title.length > 0,
      )
      .map((t) => ({
        title: t.title,
        description: t.description,
        suggestedDueDate:
          typeof t.suggestedDueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.suggestedDueDate)
            ? t.suggestedDueDate
            : null,
      }));

    context.logger.info(`Extracted ${tasks.length} tasks from email ${input.emailId}`);
    return { tasks };
  } catch (err) {
    context.logger.error("Failed to parse task extraction response", err);
    return { tasks: [] };
  }
}
