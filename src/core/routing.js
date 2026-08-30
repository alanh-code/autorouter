export function validateStageModelIds(stages, availableModels) {
  if (stages.length === 0) {
    return "";
  }

  const availableModelIds = new Set(availableModels.map((model) => model.id));
  const missing = stages.filter((stage) => !stage.modelId).map((stage) => stage.label);

  if (missing.length > 0) {
    return `base model omitted modelId for stages: ${missing.join(", ")}`;
  }

  const invalid = stages.filter((stage) => !availableModelIds.has(stage.modelId));

  if (invalid.length > 0) {
    const available = availableModels.map((model) => model.id).join(", ");
    const invalidChoices = invalid.map((stage) => `${stage.label} -> ${stage.modelId}`).join(", ");
    return `base model selected unavailable model IDs: ${invalidChoices}. Available models: ${available}`;
  }

  return "";
}
