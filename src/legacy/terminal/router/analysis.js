import {allowedStageTools} from "../../../constants.js";

export function normalizeClarificationQuestion(parsed) {
  const question = String(parsed?.clarification ?? parsed?.question ?? "").trim();

  if (!question) {
    return "";
  }

  return question.endsWith("?") ? question.slice(0, 240) : `${question.slice(0, 239)}?`;
}

export function normalizeAnalyzedStages(stages) {
  if (!Array.isArray(stages)) {
    return [];
  }

  return stages
    .map((stage) => {
      return {
        label: String(stage?.label ?? "").trim().slice(0, 48),
        kind: String(stage?.kind ?? "").trim().toLowerCase().slice(0, 32),
        goal: String(stage?.goal ?? "").trim().slice(0, 240),
        modelId: String(stage?.modelId ?? stage?.model ?? "").trim(),
        modelChoiceReason: String(stage?.modelChoiceReason ?? stage?.reason ?? "").trim().slice(0, 300),
        tools: normalizeStageTools(stage?.tools)
      };
    })
    .filter((stage) => stage.label)
    .slice(0, 6);
}

function normalizeStageTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return [...new Set(tools.map((tool) => String(tool).trim()).filter((tool) => allowedStageTools.has(tool)))];
}
