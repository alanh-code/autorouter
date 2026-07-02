import {allowedStageTools} from "../constants.js";

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

export function validateStageModelIds(stages, enabledModels) {
  if (stages.length === 0) {
    return "";
  }

  const enabledModelIds = new Set(enabledModels.map((model) => model.id));
  const missing = stages.filter((stage) => !stage.modelId).map((stage) => stage.label);

  if (missing.length > 0) {
    return `base model omitted modelId for stages: ${missing.join(", ")}`;
  }

  const invalid = stages.filter((stage) => !enabledModelIds.has(stage.modelId));

  if (invalid.length > 0) {
    const available = enabledModels.map((model) => model.id).join(", ");
    const invalidChoices = invalid.map((stage) => `${stage.label} -> ${stage.modelId}`).join(", ");
    return `base model selected unavailable model IDs: ${invalidChoices}. Available models: ${available}`;
  }

  return "";
}

function normalizeStageTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return [...new Set(tools.map((tool) => String(tool).trim()).filter((tool) => allowedStageTools.has(tool)))];
}
