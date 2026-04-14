import { memo, useState, useRef, useEffect, useCallback } from "react";
import type { InboxDensity, SnoozedEmail } from "../../shared/types";
import type { EmailThread } from "../store";
import { useAppStore } from "../store";
import { formatSnoozeTime } from "./SnoozeMenu";

interface EmailRowProps {
  thread: EmailThread;
  isSelected: boolean;
  isChecked: boolean;
  isMultiSelectActive: boolean;
  density: InboxDensity;
  onClick: (e: React.MouseEvent) => void;
  onCheckboxChange: () => void;
  snoozeInfo?: SnoozedEmail;
  returnTime?: number; // Unsnooze return time — shown instead of last message time
  accountLabel?: string; // Account display label shown in unified view
  accountColor?: string; // Account color shown in unified view
}

// Density-specific style maps
const densityStyles = {
  default: {
    row: "h-10 px-4 gap-2 text-sm",
    senderWidth: "w-32",
    priorityBadge: "text-[10px] px-1.5 py-0.5",
    time: "w-28 text-xs",
    threadBadge: "text-[10px] w-5 h-5",
    unreadDot: "w-1.5 h-1.5",
  },
  compact: {
    row: "h-8 px-3 gap-1.5 text-xs",
    senderWidth: "w-28",
    priorityBadge: "text-[9px] px-1 py-px",
    time: "w-24 text-[10px]",
    threadBadge: "text-[9px] w-4 h-4",
    unreadDot: "w-1.5 h-1.5",
  },
} as const;

// Format relative date compactly
function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatSnoozeCountdown(snoozeUntil: number): string {
  const diffMs = snoozeUntil - Date.now();
  if (diffMs <= 0) return "now";
  const diffMins = Math.ceil(diffMs / 60000);
  const diffHours = Math.ceil(diffMs / 3600000);
  const diffDays = Math.ceil(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(snoozeUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Extract sender name from email address
function extractSenderName(from: string): string {
  const match = from.match(/^([^<]+)/);
  return match ? match[1].trim() : from;
}

// Decode HTML entities (Gmail API returns snippets/subjects with entities like &#39;)
function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

// Get priority label info
function getPriorityLabel(thread: EmailThread): { text: string; className: string } | null {
  if (thread.draft?.status === "created") {
    return {
      text: "Done",
      className: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300",
    };
  }
  if (!thread.analysis) {
    return null; // Unanalyzed - no label
  }
  // Note: the store's categorization uses effectiveUserReplied (with a grace period)
  // while we check userReplied directly. During the ~3 min grace window, the badge
  // may show "Skip" while the thread still sits in Priority. This is acceptable:
  // the user just replied so "Skip" is the correct eventual state.
  if (!thread.analysis.needsReply || thread.userReplied) {
    return {
      text: "Skip",
      className: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
    };
  }
  const priority = thread.analysis.priority || "medium";
  const colors: Record<string, string> = {
    high: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300",
    medium: "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300",
    low: "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
  };
  return {
    text: priority.charAt(0).toUpperCase() + priority.slice(1),
    className: colors[priority] || colors.medium,
  };
}

const PRIORITY_OPTIONS = [
  { value: "skip", label: "Skip", needsReply: false, priority: null as string | null },
  { value: "low", label: "Low", needsReply: true, priority: "low" },
  { value: "medium", label: "Medium", needsReply: true, priority: "medium" },
  { value: "high", label: "High", needsReply: true, priority: "high" },
] as const;

const PRIORITY_COLORS: Record<string, string> = {
  skip: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
  low: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300",
  medium: "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300",
  high: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300",
};

function PriorityDropdown({
  thread,
  currentValue,
  onClose,
  anchorRef,
}: {
  thread: EmailThread;
  currentValue: string;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const updateEmail = useAppStore((s) => s.updateEmail);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, anchorRef]);

  const handleSelect = async (opt: (typeof PRIORITY_OPTIONS)[number]) => {
    if (opt.value === currentValue) {
      onClose();
      return;
    }
    const emailId = thread.latestReceivedEmail.id;
    try {
      await window.api.analysis.overridePriority(emailId, opt.needsReply, opt.priority);
      updateEmail(emailId, {
        analysis: {
          ...thread.latestReceivedEmail.analysis!,
          needsReply: opt.needsReply,
          priority: (opt.priority as "high" | "medium" | "low" | null) ?? undefined,
        },
      });
    } catch (err) {
      console.error("Failed to override priority:", err);
    }
    onClose();
  };

  return (
    <div
      ref={dropdownRef}
      className="absolute z-50 mt-1 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg py-1 min-w-[100px]"
      onClick={(e) => e.stopPropagation()}
    >
      {PRIORITY_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={(e) => {
            e.stopPropagation();
            handleSelect(opt);
          }}
          className={`w-full px-3 py-1.5 text-xs text-left flex items-center gap-2 transition-colors
            ${opt.value === currentValue ? "bg-gray-100 dark:bg-gray-700" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              opt.value === "high"
                ? "bg-red-500"
                : opt.value === "medium"
                  ? "bg-yellow-500"
                  : opt.value === "low"
                    ? "bg-blue-500"
                    : "bg-gray-400"
            }`}
          />
          <span className="text-gray-700 dark:text-gray-200">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

// Memoized so that j/k navigation only re-renders the two rows whose
// isSelected changed, not every row in the list.  The custom comparator
// skips onClick/onCheckboxChange (always new arrow functions from the parent).
export const EmailRow = memo(
  function EmailRow({
    thread,
    isSelected,
    isChecked,
    isMultiSelectActive,
    density,
    onClick,
    onCheckboxChange,
    snoozeInfo,
    returnTime,
    accountLabel,
    accountColor,
  }: EmailRowProps) {
    const senderName = extractSenderName(thread.displaySender);
    const time = returnTime
      ? formatRelativeDate(new Date(returnTime).toISOString())
      : formatRelativeDate(thread.latestReceivedEmail.date);
    const rawSnippet = thread.latestEmail.snippet || "";
    const snippet = decodeHtmlEntities(rawSnippet);
    const priorityLabel = getPriorityLabel(thread);
    // Fallback to "default" if stored density is unrecognized (e.g. removed "comfortable")
    const ds = densityStyles[density] ?? densityStyles.default;

    const [showPriorityMenu, setShowPriorityMenu] = useState(false);
    const priorityBadgeRef = useRef<HTMLSpanElement>(null);
    const closePriorityMenu = useCallback(() => setShowPriorityMenu(false), []);

    const isUnread = thread.isUnread;
    const isRecentlyUnsnoozed = returnTime !== undefined;
    // Unsnoozed emails appear bold like unread emails (without marking unread in Gmail)
    const isVisuallyUnread = isUnread || isRecentlyUnsnoozed;

    const showChecked = isChecked || isMultiSelectActive;

    return (
      <div
        data-thread-id={thread.threadId}
        data-selected={isSelected ? "true" : undefined}
        className={`
        w-full ${ds.row} flex items-center text-left
        border-b border-gray-100 dark:border-gray-700/50 transition-colors group
        ${
          isSelected && !isChecked
            ? "bg-blue-600 text-white"
            : isChecked
              ? "bg-blue-50 dark:bg-blue-900/20 text-gray-900 dark:text-gray-100"
              : "hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-900 dark:text-gray-100"
        }
      `}
      >
        {/* Account color dot — far left */}
        {accountLabel && (
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              isSelected && !isChecked
                ? "bg-white/50"
                : accountColor
                  ? ""
                  : "bg-gray-300 dark:bg-gray-600"
            }`}
            style={
              accountColor && !(isSelected && !isChecked)
                ? { backgroundColor: accountColor }
                : undefined
            }
            title={accountLabel}
          />
        )}

        {/* Checkbox / Unread indicator area */}
        <div className="w-5 flex-shrink-0 flex items-center justify-center">
          {showChecked ? (
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => {
                e.stopPropagation();
                onCheckboxChange();
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 cursor-pointer"
              data-testid="thread-checkbox"
            />
          ) : (
            <div className="w-2 flex items-center justify-center">
              {isRecentlyUnsnoozed ? (
                <div
                  className={`${ds.unreadDot} rounded-full ${isSelected ? "bg-white" : "bg-purple-500"}`}
                />
              ) : isUnread ? (
                <div
                  className={`${ds.unreadDot} rounded-full ${isSelected ? "bg-white" : "bg-blue-500"}`}
                />
              ) : null}
            </div>
          )}
        </div>

        {/* Clickable area for opening the thread */}
        <button
          onClick={onClick}
          className="flex-1 flex items-center gap-2 min-w-0 h-full text-left"
        >
          {/* Sender name */}
          <span
            className={`${ds.senderWidth} truncate flex-shrink-0 font-medium ${
              isSelected && !isChecked
                ? "text-white"
                : isVisuallyUnread
                  ? "text-gray-900 dark:text-gray-100"
                  : "text-gray-600 dark:text-gray-400"
            }`}
          >
            {senderName}
          </span>

          {/* Priority label — clickable to change */}
          {priorityLabel && (
            <span className="relative flex-shrink-0">
              <span
                ref={priorityBadgeRef}
                onClick={(e) => {
                  e.stopPropagation();
                  if (thread.analysis) setShowPriorityMenu((v) => !v);
                }}
                className={`
            ${ds.priorityBadge} rounded uppercase font-medium w-14 text-center cursor-pointer inline-block
            ${isSelected && !isChecked ? "bg-white/20 text-white" : priorityLabel.className}
          `}
              >
                {priorityLabel.text}
              </span>
              {showPriorityMenu && thread.analysis && (
                <PriorityDropdown
                  thread={thread}
                  currentValue={
                    !thread.analysis.needsReply || thread.userReplied
                      ? "skip"
                      : (thread.analysis.priority || "medium")
                  }
                  onClose={closePriorityMenu}
                  anchorRef={priorityBadgeRef}
                />
              )}
            </span>
          )}

          {/* Subject + Snippet (combined to use available space) */}
          <div
            className={`flex-1 min-w-0 flex items-center ${density === "compact" ? "gap-1.5" : "gap-2"}`}
          >
            <span
              className={`font-medium truncate flex-shrink-0 max-w-[85%] ${
                isSelected && !isChecked
                  ? "text-white"
                  : isVisuallyUnread
                    ? "text-gray-900 dark:text-gray-100"
                    : "text-gray-700 dark:text-gray-300"
              }`}
            >
              {decodeHtmlEntities(thread.subject)}
            </span>
            <span
              className={`flex-shrink ${isSelected && !isChecked ? "text-white/40" : "text-gray-300 dark:text-gray-600"}`}
            >
              —
            </span>
            {thread.draft ? (
              <>
                <span
                  className={`flex-shrink-0 ${isSelected && !isChecked ? "text-green-200" : "text-green-600 dark:text-green-400"}`}
                >
                  <svg
                    className="w-3 h-3 inline-block mr-0.5 -mt-px"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                  Draft
                </span>
                <span
                  className={`truncate min-w-0 ${isSelected && !isChecked ? "text-white/60" : "text-gray-400"}`}
                >
                  {(thread.draft.body ?? "")
                    .replace(/<[^>]*>/g, "")
                    .replace(/\n/g, " ")
                    .substring(0, 100)}
                </span>
              </>
            ) : (
              <span
                className={`truncate min-w-0 ${
                  isSelected && !isChecked ? "text-white/60" : "text-gray-400"
                }`}
              >
                {snippet}
              </span>
            )}
          </div>

          {/* Snooze indicator */}
          {snoozeInfo && (
            <span
              className={`flex items-center gap-0.5 flex-shrink-0 ${
                isSelected && !isChecked ? "text-white/60" : "text-amber-500 dark:text-amber-400"
              }`}
              title={`Snoozed until ${formatSnoozeTime(snoozeInfo.snoozeUntil)}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </span>
          )}

          {/* Time */}
          <span
            className={`${ds.time} text-right flex-shrink-0 tabular-nums whitespace-nowrap ${
              isSelected && !isChecked
                ? "text-white/60"
                : snoozeInfo
                  ? "text-amber-500 dark:text-amber-400"
                  : "text-gray-400"
            }`}
          >
            {snoozeInfo ? formatSnoozeCountdown(snoozeInfo.snoozeUntil) : time}
          </span>

          {/* Thread count badge */}
          {thread.hasMultipleEmails && (
            <span
              className={`
          ${ds.threadBadge} rounded-full flex items-center justify-center flex-shrink-0
          ${
            isSelected && !isChecked
              ? "bg-white/20 text-white"
              : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
          }
        `}
            >
              {thread.emails.length}
            </span>
          )}
        </button>
      </div>
    );
  },
  (prev, next) =>
    prev.thread === next.thread &&
    prev.isSelected === next.isSelected &&
    prev.isChecked === next.isChecked &&
    prev.isMultiSelectActive === next.isMultiSelectActive &&
    prev.density === next.density &&
    prev.snoozeInfo === next.snoozeInfo &&
    prev.returnTime === next.returnTime &&
    prev.accountLabel === next.accountLabel &&
    prev.accountColor === next.accountColor,
  // onClick / onCheckboxChange intentionally omitted — they are stable in behavior
  // but are new arrow function references on each parent render.
);
