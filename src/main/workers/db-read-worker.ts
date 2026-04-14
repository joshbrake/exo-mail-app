import type { DashboardEmail } from "../../shared/types";
import { createLogger } from "../services/logger";
import {
  getAccounts,
  getInboxEmails,
  getInboxEmailsPaginated,
  initDatabase,
  type AccountRecord,
} from "../db";

type DbReadWorkerRequest =
  | { type: "list-accounts"; requestId: string }
  | { type: "get-inbox-emails"; requestId: string; accountId: string }
  | { type: "get-inbox-page"; requestId: string; accountId: string; limit: number; offset: number };

type DbReadWorkerResponse =
  | { type: "response"; requestId: string; success: true; result: unknown }
  | { type: "response"; requestId: string; success: false; error: string };

const log = createLogger("db-read-worker");

const tInit = performance.now();
initDatabase();
log.info(`[PERF] db-read-worker initDatabase ${(performance.now() - tInit).toFixed(1)}ms`);

function postMessage(message: DbReadWorkerResponse): void {
  process.parentPort.postMessage(message);
}

function handleRequest(message: DbReadWorkerRequest): void {
  try {
    switch (message.type) {
      case "list-accounts": {
        const accounts = getAccounts();
        postMessage({
          type: "response",
          requestId: message.requestId,
          success: true,
          result: accounts satisfies AccountRecord[],
        });
        return;
      }

      case "get-inbox-emails": {
        const emails = getInboxEmails(message.accountId);
        postMessage({
          type: "response",
          requestId: message.requestId,
          success: true,
          result: emails satisfies DashboardEmail[],
        });
        return;
      }

      case "get-inbox-page": {
        const result = getInboxEmailsPaginated(message.accountId, message.limit, message.offset);
        postMessage({
          type: "response",
          requestId: message.requestId,
          success: true,
          result,
        });
        return;
      }
    }
  } catch (error) {
    postMessage({
      type: "response",
      requestId: message.requestId,
      success: false,
      error: error instanceof Error ? error.message : "Unknown db-read-worker error",
    });
  }
}

process.parentPort.on("message", (message: DbReadWorkerRequest) => {
  handleRequest(message);
});
