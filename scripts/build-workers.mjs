import { resolve } from "path";
import { build } from "vite";

const sharedExternal = ["electron", "better-sqlite3", /^[^./]/];

async function buildWorker(entry, fileName, emptyOutDir) {
  await build({
    build: {
      outDir: "out/worker",
      emptyOutDir,
      lib: {
        entry: resolve(process.cwd(), entry),
        formats: ["cjs"],
        fileName: () => fileName,
      },
      rollupOptions: {
        external: sharedExternal,
      },
      target: "node20",
      minify: false,
      sourcemap: true,
    },
    resolve: {
      conditions: ["node"],
    },
  });
}

await buildWorker("src/main/agents/agent-worker.ts", "agent-worker.cjs", true);
await buildWorker("src/main/workers/db-read-worker.ts", "db-read-worker.cjs", false);
