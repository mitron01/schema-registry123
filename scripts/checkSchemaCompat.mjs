#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Проверка: установлен ли json-schema-diff
try {
  require.resolve("json-schema-diff");
} catch {
  console.error("Ошибка: пакет 'json-schema-diff' не установлен.");
  console.error("Установите: npm install json-schema-diff --save-dev");
  process.exit(1);
}

// Глоб для JSON-схем (настрой под себя)
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

function getJsonSchemaDiffBin() {
  const base = path.join(process.cwd(), "node_modules", ".bin", "json-schema-diff");
  return process.platform === "win32" ? `${base}.cmd` : base;
}

(async () => {
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
    console.log("Нет изменённых JSON-схем в staging.");
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
      console.log(`Новый файл: ${file} — пропускаю проверку совместимости`);
    }

    // Получаем текущую версию из index (staging)
    const newRes = git(["show", `:${file}`]);
    if (!newRes.ok) {
      console.warn(`Не удалось получить staged версию: ${file}`);
      continue;
    }
    newContent = newRes.stdout;

    // Записываем во временные файлы
    await fs.writeFile(oldTmp, oldContent, "utf8");
    await fs.writeFile(newTmp, newContent, "utf8");

    console.log(`→ Проверяю ${file}…`);

    // Запускаем json-schema-diff
    const result = run(jsdiff, [oldTmp, newTmp], { stdio: "pipe" });

    // Удаляем временные файлы
    await Promise.all([
      fs.unlink(oldTmp).catch(() => {}),
      fs.unlink(newTmp).catch(() => {}),
    ]);

    // Анализируем вывод
    if (result.status !== 0) {
      const output = result.stdout + result.stderr;
      const breaking = output
          .split("\n")
          .filter((line) => line.includes("- ") || line.includes("changed") || line.includes("removed"))
          .map((line) => line.trim());

      if (breaking.length > 0) {
        console.error(`\nЛомающие изменения в ${file}:`);
        breaking.forEach((msg) => console.error(`  ${msg}`));
        hasBreaking = true;
      } else {
        console.error(`\nОбнаружено несовместимое изменение в ${file}`);
        hasBreaking = true;
      }
    } else {
      console.log(`Совместимо: ${file}`);
    }
  }

  // Финальный вердикт
  if (hasBreaking) {
    console.error("\nКоммит отклонён: найдены ломающие изменения в JSON-схемах.");
    process.exit(1);
  } else {
    console.log("Проверка совместимости JSON-схем пройдена.");
    process.exit(0);
  }
})().catch((err) => {
  console.error("Неожиданная ошибка:", err.message || err);
  process.exit(1);
});