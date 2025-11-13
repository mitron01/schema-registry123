#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// Какие ключи считаем аннотациями и игнорируем при сравнении
const ANNOTATION_KEYS = new Set([
  "description",
  "title",
  "$id",
  "$comment",
  "examples"
]);

// Утилита для вызова git
function git(args) {
  const res = spawnSync("git", args, { encoding: "utf8" });

  if (res.error) {
    throw res.error;
  }

  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout || "").trim(),
    stderr: res.stderr || ""
  };
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Рекурсивный чек на ломающие изменения между двумя JSON Schema.
 * oldSchema — версия из HEAD
 * newSchema — версия из индекса (staging)
 *
 * Возвращает массив строк-причин. Если он пустой — считаем совместимым.
 */
function collectBreakingChanges(oldSchema, newSchema, path = "") {
  const reasons = [];

  const here = path || "<root>";

  // 1. Тип изменился — точно ломающее изменение
  if (oldSchema && newSchema && oldSchema.type && newSchema.type) {
    if (oldSchema.type !== newSchema.type) {
      reasons.push(
          `${here}: type changed from "${oldSchema.type}" to "${newSchema.type}"`
      );
    }
  }

  // 2. additionalProperties стало менее разрешительным (любое изменение считаем ломаюшим)
  if (
      Object.prototype.hasOwnProperty.call(oldSchema || {}, "additionalProperties") ||
      Object.prototype.hasOwnProperty.call(newSchema || {}, "additionalProperties")
  ) {
    const oldAP = (oldSchema || {}).additionalProperties;
    const newAP = (newSchema || {}).additionalProperties;

    // Любое изменение additionalProperties считаем ломающим
    if (JSON.stringify(oldAP) !== JSON.stringify(newAP)) {
      reasons.push(
          `${here}: additionalProperties changed from ${JSON.stringify(
              oldAP
          )} to ${JSON.stringify(newAP)}`
      );
    }
  }

  // 3. required: если в новой схеме появились новые обязательные поля — ломаем
  const oldReq = Array.isArray(oldSchema && oldSchema.required)
      ? oldSchema.required
      : [];
  const newReq = Array.isArray(newSchema && newSchema.required)
      ? newSchema.required
      : [];

  for (const prop of newReq) {
    if (!oldReq.includes(prop)) {
      reasons.push(`${here}: property "${prop}" became required`);
    }
  }

  // 4. properties: удаление или ужесточение полей
  const oldProps = isObject(oldSchema) && isObject(oldSchema.properties)
      ? oldSchema.properties
      : {};
  const newProps = isObject(newSchema) && isObject(newSchema.properties)
      ? newSchema.properties
      : {};

  // 4.1. поля, которые были и пропали — ломаем
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) {
      reasons.push(`${here}: property "${key}" was removed`);
      continue;
    }

    // Рекурсивно сравниваем схему поля
    const nested = collectBreakingChanges(
        oldProps[key],
        newProps[key],
        path ? `${path}.properties.${key}` : `properties.${key}`
    );
    reasons.push(...nested);
  }

  // Добавленные новые свойства (которые не required) считаем безопасными —
  // поэтому ничего не делаем для ключей, которых не было в старой схеме.

  // 5. Остальные ключи (кроме аннотаций / служебных)
  if (isObject(oldSchema) && isObject(newSchema)) {
    const oldKeys = Object.keys(oldSchema);
    for (const key of oldKeys) {
      if (key === "type" || key === "properties" || key === "required" || key === "additionalProperties") {
        continue;
      }
      if (ANNOTATION_KEYS.has(key)) {
        // description/title и т.п. — игнорируем
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(newSchema, key)) {
        // Ключ пропал — считаем ломаюшим
        reasons.push(`${here}: keyword "${key}" was removed`);
        continue;
      }

      const oldVal = oldSchema[key];
      const newVal = newSchema[key];

      const childPath = path ? `${path}.${key}` : key;

      if (isObject(oldVal) && isObject(newVal)) {
        reasons.push(...collectBreakingChanges(oldVal, newVal, childPath));
      } else if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        // Для простоты считаем, что любое изменение массива (кроме аннотаций выше) — ломающее
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          reasons.push(
              `${childPath}: array value changed from ${JSON.stringify(
                  oldVal
              )} to ${JSON.stringify(newVal)}`
          );
        }
      } else {
        // Примитив/разные типы — любое изменение ломающее
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          reasons.push(
              `${childPath}: value changed from ${JSON.stringify(
                  oldVal
              )} to ${JSON.stringify(newVal)}`
          );
        }
      }
    }
  }

  return reasons;
}

async function main() {
  console.log("Running JSON schema compatibility check...");

  const SCHEMA_GLOB = process.env.SCHEMA_GLOB || "json/**/*.json";

  // Находим изменённые JSON-схемы в индексе
  const diff = git([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
    "--",
    SCHEMA_GLOB
  ]);

  if (!diff.ok || !diff.stdout) {
    console.log("No modified JSON schemas in staging.");
    return;
  }

  const files = diff.stdout.split(/\r?\n/).filter(Boolean);
  if (files.length === 0) {
    console.log("No modified JSON schemas in staging.");
    return;
  }

  let hasBreaking = false;

  for (const file of files) {
    // Если файла не было в HEAD — новый файл, пропускаем проверки совместимости
    const headExists = git(["cat-file", "-e", `HEAD:${file}`]);
    if (!headExists.ok) {
      console.log(
          `New file: ${file} — skipping compatibility check (no previous version).`
      );
      continue;
    }

    const oldRes = git(["show", `HEAD:${file}`]);
    const newRes = git(["show", `:${file}`]);

    if (!oldRes.ok || !newRes.ok) {
      console.error(`Failed to read file contents for ${file}`);
      if (oldRes.stderr) console.error(oldRes.stderr);
      if (newRes.stderr) console.error(newRes.stderr);
      hasBreaking = true;
      continue;
    }

    let oldSchema;
    let newSchema;

    try {
      oldSchema = JSON.parse(oldRes.stdout);
      newSchema = JSON.parse(newRes.stdout);
    } catch (err) {
      console.error(`Failed to parse JSON for ${file}: ${err.message}`);
      hasBreaking = true;
      continue;
    }

    console.log(`Checking ${file}...`);

    const reasons = collectBreakingChanges(oldSchema, newSchema);

    if (reasons.length > 0) {
      console.error(`\nBreaking changes in ${file}:`);
      for (const r of reasons) {
        console.error(`  - ${r}`);
      }
      hasBreaking = true;
    } else {
      console.log(`Compatible: ${file}`);
    }
  }

  if (hasBreaking) {
    console.error("\nCommit rejected: breaking changes detected.");
    process.exit(1);
  } else {
    console.log("Check passed.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
