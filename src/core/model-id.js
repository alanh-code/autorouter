export function parseModelId(id) {
  if (!id || !id.includes(":")) {
    return {provider: "", model: id ?? ""};
  }

  const [provider, ...modelParts] = id.split(":");
  return {provider, model: modelParts.join(":")};
}
