#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// === Проверка: установлен ли json-schema-diff в node_modules/.bin ===
let jsdiffPath;
try {
  const binPath = path.join(process.cwd(), "node_modules", ".bin", "json-schema-diff");
  const winBinPath = binPath + ".cmd";
  jsdiffPath = process.platform === "win32" ? winBinPath : binPath;

  // Проверяем, существует ли файл
  await fs.access(jsdiffPath);
} catch (err) {
  console.error("Error: 'json-schema-diff' not found in node_modules/.bin");
  console.error("Run: npm install json-schema-diff --save-dev");
  process.exit(1);
}

function getJsonSchemaDiffBin() {
  return jsdiffPath;
}

// === Глоб для JSON-схем (настрой под себя) ===
const SCHEMA_GLOB = process.env.SCHEMA_GLOB || "json/**/*.schema.json";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.error) throw res.error;
  return res;
}

function git(args) {
  const r = run("git", args);
  return { ok: r.status === 0, stdout: r.stdout.trim(), stderr: r.stderr };
}

(async () => {
  console.log("→ Running JSON schema compatibility check...");

  // Получаем изменённые файлы в staging
  const diff = git([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
    "--",
    SCHEMA_GLOB,
  ]);

  if (!diff.ok || !diff.stdout) {
    console.log("No modified JSON schemas in staging.");
    process.exit(0);
  }

  const files = diff.stdout.split("\n").filter(Boolean);
  if (files.length === 0) process.exit(0);

  const jsdiff = getJsonSchemaDiffBin();
  let hasBreaking = false;

  for (const file of files) {
    const oldTmp = path.join(os.tmpdir(), `schema-old-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const newTmp = path.join(os.tmpdir(), `schema-new-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

    let oldContent = "{}";
    let newContent = "";

    // Проверяем: был ли файл в HEAD?
    const headExists = git(["cat-file", "-e", `HEAD:${file}`]).ok;

    if (headExists) {
      const oldRes = git(["show", `HEAD:${file}`]);
      oldContent = oldRes.ok ? oldRes.stdout : "{}";
    } else {
      console.log(`New file: ${file} — skipping compatibility check`);
    }

    // Получаем текущую версию из staging
    const newRes = git(["show", `:${file}`]);
    if (!newRes.ok) {
      console.warn(`Failed to get staged version: ${file}`);
      continue;
    }
    newContent = newRes.stdout;

    // Записываем во временные файлы
    await fs.writeFile(oldTmp, oldContent, "utf8");
    await fs.writeFile(newTmp, newContent, "utf8");

    console.log(`→ Checking ${file}...`);

    // Запускаем json-schema-diff
    const result = run(jsdiff, [oldTmp, newTmp], { stdio: "pipe" });

    // Удаляем временные файлы
    await Promise.all([
      fs.unlink(oldTmp).catch(() => {}),
      fs.unlink(newTmp).catch(() => {}),
    ]);

    // Анализируем результат
    if (result.status !== 0) {
      const output = result.stdout + result.stderr;
      const breaking = output
          .split("\n")
          .filter(line => line.includes("- ") || line.includes("changed") || line.includes("removed"))
          .map(line => line.trim());

      if (breaking.length > 0) {
        console.error(`\nBreaking changes in ${file}:`);
        breaking.forEach(msg => console.error(`  ${msg}`));
        hasBreaking = true;
      } else {
        console.error(`\nIncompatible change detected in ${file}`);
        hasBreaking = true;
      }
    } else {
      console.log(`Compatible: ${file}`);
    }
  }

  // Финальный вердикт
  if (hasBreaking) {
    console.error("\nCommit rejected: breaking changes detected in JSON schemas.");
    process.exit(1);
  } else {
    console.log("JSON schema compatibility check passed.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("Unexpected error:", err.message || err);
  process.exit(1);
});