#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Защита от отсутствия json-schema-diff
try {
  require.resolve('json-schema-diff');
} catch (e) {
  console.error('Ошибка: json-schema-diff не установлен.');
  console.error('Запустите: npm install json-schema-diff --save-dev');
  process.exit(1);
}

const SCHEMA_GLOB = process.env.SCHEMA_GLOB || "json/**/*.json"; // поменяйте под ваш путь

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", ...opts });
  if (res.error) throw res.error;
  return res;
}
function git(args) {
  const r = run("git", args);
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function jsdiffBin() {
  return process.platform === "win32"
    ? path.join(process.cwd(), "node_modules", ".bin", "json-schema-diff.cmd")
    : path.join(process.cwd(), "node_modules", ".bin", "json-schema-diff");
}

(async () => {
  const diff = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--", SCHEMA_GLOB]);
  if (!diff.ok) process.exit(0);
  const files = diff.stdout.split("\n").filter(Boolean);
  if (files.length === 0) process.exit(0);

  const jsdiff = jsdiffBin();
  let hadBreaking = false;

  for (const f of files) {
    const oldTmp = path.join(os.tmpdir(), `old-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const newTmp = path.join(os.tmpdir(), `new-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

    const wasInHead = git(["cat-file", "-e", `HEAD:${f}`]).ok;
    if (wasInHead) {
      const rOld = git(["show", `HEAD:${f}`]);
      await fs.writeFile(oldTmp, rOld.ok ? rOld.stdout : "{}", "utf8");
    } else {
      await fs.writeFile(oldTmp, "{}", "utf8");
    }

    const rNew = git(["show", `:${f}`]);
    if (!rNew.ok) continue;
    await fs.writeFile(newTmp, rNew.stdout, "utf8");

    console.log(`→ Проверяю ${f}…`);
    const res = run(jsdiff, [oldTmp, newTmp], { stdio: "inherit" });
    if (res.status !== 0) {
      console.error(`🛑 Ломающие изменения в ${f}.`);
      hadBreaking = true;
    }

    await fs.unlink(oldTmp).catch(() => {});
    await fs.unlink(newTmp).catch(() => {});
  }

  if (hadBreaking) {
    console.error("\nКоммит отклонён: найдены несовместимые изменения JSON-схем.");
    process.exit(1);
  } else {
    console.log("✅ Проверка совместимости JSON-схем пройдена.");
  }
})().catch((e) => { console.error(e); process.exit(1); });