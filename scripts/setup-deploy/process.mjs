import { spawn } from "node:child_process";

const WINDOWS_BATCH_RE = /\.(cmd|bat)$/i;
const CMD_META_CHARS_RE = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg) {
  let escaped = `${arg}`.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`.replace(CMD_META_CHARS_RE, "^$1");
}

// Node 18.20+/20.12+ (CVE-2024-27980) は Windows で .cmd/.bat を
// shell なしで spawn すると EINVAL になるため、cmd.exe 経由で起動する。
function toSpawnable(command, args) {
  if (process.platform !== "win32" || !WINDOWS_BATCH_RE.test(command)) {
    return { command, args, extraOptions: {} };
  }
  const commandLine = [
    command.replace(CMD_META_CHARS_RE, "^$1"),
    ...args.map(escapeCmdArgument),
  ].join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    extraOptions: { windowsVerbatimArguments: true },
  };
}

export function runCommand(command, args, options = {}) {
  const { cwd, env, inherit = false, input, allowFail = false } = options;

  return new Promise((resolve, reject) => {
    const spawnable = toSpawnable(command, args);
    const child = spawn(spawnable.command, spawnable.args, {
      ...spawnable.extraOptions,
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: inherit
        ? "inherit"
        : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (!inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }

    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (code !== 0 && !allowFail) {
        const detail = (stderr || stdout || `exit ${code}`).trim();
        const error = new Error(detail);
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

export async function commandExists(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = await runCommand(probe, [command], { allowFail: true });
  return result.code === 0;
}
