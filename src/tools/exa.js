import {EXA_DEFAULT_BASE_URL} from "../constants.js";
import {formatDollarCost, parseDollarText} from "../costs.js";

export function buildWebSearchQuery(task, route) {
  return [
    task.trim(),
    route.goal ? `Need: ${route.goal}` : "",
    "Use current sources."
  ].filter(Boolean).join("\n");
}

export async function callWebSearchTool({config, query, signal}) {
  const tool = config.tools?.webSearch;

  if (!tool?.enabled) {
    return {
      provider: "exa",
      toolLabel: "Exa Search",
      toolName: "exa.search",
      query,
      resultCount: 0,
      usageText: "tool unavailable",
      content: "Web search is disabled in autorouter.config.json."
    };
  }

  if (tool.provider !== "exa") {
    return {
      provider: tool.provider ?? "web",
      toolLabel: "Web Search",
      toolName: `${tool.provider ?? "web"}.search`,
      query,
      resultCount: 0,
      usageText: "tool unavailable",
      content: `Web search provider is not implemented yet: ${tool.provider}`
    };
  }

  const exa = tool.providers?.exa ?? {};
  const apiKeyEnv = exa.apiKeyEnv ?? "EXA_API_KEY";
  const apiKey = process.env[apiKeyEnv];

  if (!apiKey) {
    return {
      provider: "exa",
      toolLabel: "Exa Search",
      toolName: "exa.search",
      query,
      resultCount: 0,
      usageText: "missing API key",
      content: `Exa web search was needed, but ${apiKeyEnv} is not set. Add it to .env.local and retry.`
    };
  }

  const body = {
    query,
    type: exa.searchType ?? "auto",
    numResults: exa.numResults ?? 5,
    contents: exa.contents ?? {highlights: true}
  };

  const response = await fetch(`${exa.apiBaseUrl ?? EXA_DEFAULT_BASE_URL}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    throw new Error(`Exa API returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return {
    provider: "exa",
    toolLabel: "Exa Search",
    toolName: "exa.search",
    query,
    resultCount: results.length,
    usageText: formatExaUsage(data),
    content: formatExaSearchResults(query, results)
  };
}

export function combineToolUsage(toolResults) {
  const costs = toolResults.map((result) => parseDollarText(result.usageText));

  if (costs.every((cost) => Number.isFinite(cost))) {
    return formatDollarCost(costs.reduce((total, cost) => total + cost, 0));
  }

  const usageParts = toolResults.map((result) => result.usageText).filter(Boolean);
  return usageParts.length > 0 ? usageParts.join(" + ") : "usage unavailable";
}

function formatExaUsage(data) {
  const totalCost = data?.costDollars?.total;

  if (typeof totalCost === "number") {
    return `$${totalCost.toFixed(6)}`;
  }

  return "cost unavailable";
}

function formatExaSearchResults(query, results) {
  if (results.length === 0) {
    return `No Exa search results found for:\n${query}`;
  }

  return [
    `Exa web search query:\n${query}`,
    "",
    "Search results:",
    ...results.map((result, index) => formatExaResult(result, index))
  ].join("\n");
}

function formatExaResult(result, index) {
  const highlights = Array.isArray(result.highlights)
    ? result.highlights.filter(Boolean).slice(0, 3)
    : [];
  const highlightText = highlights.length > 0
    ? limitSingleLine(highlights.join(" "), 700)
    : "";
  const parts = [
    `${index + 1}. ${result.title ?? "Untitled"}`,
    result.url ? `URL: ${result.url}` : "",
    result.publishedDate ? `Published: ${result.publishedDate}` : "",
    result.author ? `Author: ${result.author}` : "",
    result.text ? `Text: ${limitSingleLine(String(result.text), 700)}` : "",
    highlightText ? `Highlights: ${highlightText}` : ""
  ].filter(Boolean);

  return parts.join("\n");
}

function limitSingleLine(text, maxChars) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trim()} [truncated]`;
}
