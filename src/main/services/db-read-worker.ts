import { utilityProcess } from "electron";
import { existsSync } from "fs";
import path from "path";
import type { DashboardEmail } from "../../shared/types";
import type { AccountRecord } from "../db";
import { createLogger } from "./logger";

type DbReadWorkerRequest =
  | { type: "list-accounts"; requestId: string }
  | { type: "get-inbox-emails"; requestId: string; accountId: string }
  | { type: "get-inbox-page"; requestId: string; accountId: string; limit: number; offset: number };

type DbReadWorkerResponse =
  | { type: "response"; requestId: string; success: true; result: unknown }
  | { type: "response"; requestId: string; success: false; error: string };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 15_000;
const log = createLogger("db-read-worker-main");

class DbReadWorkerClient {
  private worker: Electron.UtilityProcess | null = null;
  private requestCounter = 0;
  private pending = new Map<string, PendingRequest>();

  private getWorkerPath(): string {
    return path.join(__dirname, "..", "worker", "db-read-worker.cjs");
  }

  private ensureWorker(): Electron.UtilityProcess {
    if (this.worker) return this.worker;

    const workerPath = this.getWorkerPath();
    if (!existsSync(workerPath)) {
      throw new Error(
        `DB read worker not found at ${workerPath}. Run "npm run build:worker" first.`,
      );
    }

    const worker = utilityProcess.fork(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    worker.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trimEnd().split("\n");
      for (const line of lines) {
        if (line) log.info(`[DbReadWorker:out] ${line}`);
      }
    });
    worker.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trimEnd().split("\n");
      for (const line of lines) {
        if (line) log.error(`[DbReadWorker:err] ${line}`);
      }
    });

    worker.on("message", (message: DbReadWorkerResponse) => {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.success) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
    });

    worker.on("exit", (code) => {
      log.info(`[DbReadWorker] exited with code ${code}`);
      this.worker = null;
      for (const [requestId, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`DB read worker exited with code ${code}`));
        this.pending.delete(requestId);
      }
    });

    this.worker = worker;
    return worker;
  }

  private sendRequest<T>(request: Omit<DbReadWorkerRequest, "requestId">): Promise<T> {
    const requestId = `db-read-${++this.requestCounter}-${Date.now()}`;
    const worker = this.ensureWorker();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`DB read worker request timed out: ${request.type}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer });
      worker.postMessage({ ...request, requestId } satisfies DbReadWorkerRequest);
    });
  }

  listAccounts(): Promise<AccountRecord[]> {
    return this.sendRequest<AccountRecord[]>({ type: "list-accounts" });
  }

  getInboxEmails(accountId: string): Promise<DashboardEmail[]> {
    return this.sendRequest<DashboardEmail[]>({ type: "get-inbox-emails", accountId });
  }

  getInboxPage(
    accountId: string,
    limit: number,
    offset: number,
  ): Promise<{ emails: DashboardEmail[]; hasMore: boolean }> {
    return this.sendRequest<{ emails: DashboardEmail[]; hasMore: boolean }>({
      type: "get-inbox-page",
      accountId,
      limit,
      offset,
    });
  }
}

export const dbReadWorker = new DbReadWorkerClient();
