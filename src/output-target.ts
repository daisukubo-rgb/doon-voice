export type OutputTarget = "codex" | "claude" | "gemini" | "local" | "raw";

export const DEFAULT_OUTPUT_TARGET: OutputTarget = "codex";

const labels: Record<OutputTarget, string> = {
  codex: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  local: "このPCのAI",
  raw: "AIなし",
};

export function isOutputTarget(value: string | null): value is OutputTarget {
  return value === "codex" || value === "claude" || value === "gemini" || value === "local" || value === "raw";
}

export function outputTargetLabel(target: OutputTarget): string {
  return labels[target];
}
