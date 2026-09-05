import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";

// npm.cmd is a batch file, not an executable. Use npm's JS entry point with
// the running Node binary so spaces and shell metacharacters stay literal.
export function npmInvocation({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const candidates = [
    env.npm_execpath,
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
    if (platform !== "win32") candidates.push(join(directory, "npm"));
  }
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const entry = realpathSync(candidate);
    if ([".js", ".cjs", ".mjs"].includes(extname(entry))) return { command: execPath, args: [entry] };
  }
  throw new Error("npmのJavaScript実行ファイルが見つかりません。Node.jsとnpmのインストールを確認してください。");
}

export function runNpm(args, options = {}) {
  try {
    const invocation = npmInvocation({ env: options.env ?? process.env });
    return spawnSync(invocation.command, [...invocation.args, ...args], { ...options, shell: false });
  } catch (error) {
    return { status: null, signal: null, error };
  }
}
