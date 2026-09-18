export type OutputTarget = "codex" | "claude" | "gemini" | "local" | "raw";
export type SelectionQuestionTarget = Exclude<OutputTarget, "raw">;

export const DEFAULT_OUTPUT_TARGET: OutputTarget = "codex";
export const DEFAULT_SELECTION_QUESTION_TARGET: SelectionQuestionTarget = "codex";

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

export function isSelectionQuestionTarget(value: string | null): value is SelectionQuestionTarget {
  return value === "codex" || value === "claude" || value === "gemini" || value === "local";
}

export function outputTargetLabel(target: OutputTarget): string {
  return labels[target];
}
