export function parseModelId(id) {
  if (!id || !id.includes(":")) {
    return {provider: "", model: id ?? ""};
  }

  const [provider, ...modelParts] = id.split(":");
  return {provider, model: modelParts.join(":")};
}

export function normalizeModel(model) {
  const parsed = parseModelId(model?.id);

  return {
    ...model,
    provider: model?.provider ?? parsed.provider,
    model: model?.model ?? parsed.model
  };
}
