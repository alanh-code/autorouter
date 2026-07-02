import {
  CONFIG_FILE,
  MAX_FILE_EDIT_RESPONSE_TOKENS,
  MAX_FILE_WRITE_RESPONSE_TOKENS,
  MAX_FINAL_ANSWER_TOKENS,
  MAX_STAGE_RESULT_CHARS,
  MAX_TASK_INPUT_CHARS,
  fileEditTool,
  fileWriteTool,
  localCodebaseTool
} from "./constants.js";
import {formatDollarCost, formatUsageCost, parseDollarText} from "./costs.js";
import {callChatCompletion} from "./providers/chat.js";
import {getProviderConfig} from "./providers/inventory.js";
import {buildWebSearchQuery, callWebSearchTool, combineToolUsage} from "./tools/exa.js";
import {
  applyFileEditPlan,
  applyFileWritePlan,
  formatFileEditResult,
  formatFileWriteResult,
  inspectLocalCodebase
} from "./tools/local-files.js";
import {getRuntimeContext} from "./utils/runtime.js";
import {getErrorMessage, limitInputText, parseJsonObject, stripMarkdown} from "./utils/text.js";

export async function runExecution({config, execution, signal, onActivity}) {
  onActivity({
    type: "activity",
    status: "success",
    stage: "prepare execution",
    title: "Prepared",
    detail: "AutoRouter execution",
    items: [
      {action: "Read", target: CONFIG_FILE},
      {action: "Loaded", target: `${execution.routes.length} routed stages`}
    ]
  });

  const stageResults = [];

  for (let index = 0; index < execution.routes.length; index += 1) {
    const route = execution.routes[index];

    if (signal.aborted) {
      throw new Error("Execution interrupted");
    }

    const provider = getProviderConfig(config, route.provider);

    if (!provider) {
      throw new Error(`Provider is not configured: ${route.provider}`);
    }

    let content = "";
    let usageText = "";
    let activityDetail = "";
    let activityItems = [];
    let resultModelLabel = route.modelLabel;
    let resultModelName = route.modelName;
    let resultProvider = route.provider;
    let resultPricing = route.pricing ?? null;

    if (route.tools?.includes(fileWriteTool)) {
      const codebaseResult = inspectLocalCodebase(process.cwd());
      const response = await callChatCompletion({
        providerName: route.provider,
        provider,
        modelName: route.modelName,
        messages: buildFileWriteMessages(execution.task, route, stageResults, codebaseResult),
        json: true,
        maxTokens: MAX_FILE_WRITE_RESPONSE_TOKENS,
        thinking: "disabled",
        signal
      });
      const parsed = parseJsonObject(response.content);
      const writeResult = applyFileWritePlan(process.cwd(), parsed?.files);

      content = formatFileWriteResult(writeResult);
      usageText = formatUsageCost(response.usage, route);
      resultModelLabel = `${route.modelLabel} + File Write`;
      resultModelName = route.modelName;
      activityDetail = `${resultModelLabel}${usageText ? ` · ${usageText}` : ""}`;
      activityItems = [
        {action: "Read", target: codebaseResult.root},
        {action: "Proposed", target: `${writeResult.total} files`},
        {action: "Created", target: `${writeResult.created.length} files`}
      ];
    } else if (route.tools?.includes(fileEditTool)) {
      const codebaseResult = inspectLocalCodebase(process.cwd());
      const response = await callChatCompletion({
        providerName: route.provider,
        provider,
        modelName: route.modelName,
        messages: buildFileEditMessages(execution.task, route, stageResults, codebaseResult),
        json: true,
        maxTokens: MAX_FILE_EDIT_RESPONSE_TOKENS,
        thinking: "disabled",
        signal
      });
      const parsed = parseJsonObject(response.content);
      const editResult = applyFileEditPlan(process.cwd(), parsed?.edits);

      content = formatFileEditResult(editResult);
      usageText = formatUsageCost(response.usage, route);
      resultModelLabel = `${route.modelLabel} + File Edit`;
      resultModelName = route.modelName;
      activityDetail = `${resultModelLabel}${usageText ? ` · ${usageText}` : ""}`;
      activityItems = [
        {action: "Read", target: codebaseResult.root},
        {action: "Proposed", target: `${editResult.total} edits`},
        {action: "Applied", target: `${editResult.applied.length} edits`}
      ];
    } else if (route.tools?.includes(localCodebaseTool) || route.tools?.includes("web_search")) {
      const toolResults = [];

      if (route.tools.includes(localCodebaseTool)) {
        toolResults.push(inspectLocalCodebase(process.cwd()));
      }

      if (route.tools.includes("web_search")) {
        toolResults.push(await callWebSearchTool({
          config,
          query: buildWebSearchQuery(execution.task, route),
          signal
        }));
      }

      const codebaseResult = toolResults.find((result) => result.toolName === "local.codebase");
      const webResult = toolResults.find((result) => result.toolName === "exa.search");
      const resultLabels = toolResults.map((result) => result.toolLabel).join(" + ");
      content = toolResults.map((result) => result.content).join("\n\n");
      usageText = combineToolUsage(toolResults);
      resultModelLabel = resultLabels;
      resultModelName = toolResults.map((result) => result.toolName).join("+");
      resultProvider = codebaseResult?.provider ?? webResult?.provider ?? "tool";
      resultPricing = null;
      activityDetail = `${resultLabels}${usageText ? ` · ${usageText}` : ""}`;
      activityItems = [
        ...(codebaseResult
          ? [
              {action: "Read", target: codebaseResult.root},
              {action: "Loaded", target: `${codebaseResult.fileCount} files`}
            ]
          : []),
        ...(webResult
          ? [
              {action: "Searched", target: "current sources"},
              {action: "Loaded", target: `${webResult.resultCount} Exa results`}
            ]
          : [])
      ];
    } else {
      const response = await callChatCompletion({
        providerName: route.provider,
        provider,
        modelName: route.modelName,
        messages: buildStageExecutionMessages(execution.task, route, stageResults),
        maxTokens: route.maxTokens ?? 700,
        thinking: "disabled",
        signal
      });
      content = response.content.trim();
      usageText = formatUsageCost(response.usage, route);
      activityDetail = `${route.modelLabel}${usageText ? ` · ${usageText}` : ""}`;
      activityItems = [
        {action: "Asked", target: route.modelName},
        {action: "Completed", target: route.stage}
      ];
    }

    stageResults.push({
      stage: route.stage,
      modelLabel: resultModelLabel,
      modelName: resultModelName,
      provider: resultProvider,
      pricing: resultPricing,
      content,
      usageText: usageText || "usage unavailable"
    });

    onActivity({
      type: "activity",
      status: "success",
      stage: route.stage,
      title: "Ran",
      detail: activityDetail,
      items: activityItems
    });
  }

  const finalAnswer = await synthesizeFinalAnswer({
    config,
    execution,
    stageResults,
    signal
  });

  onActivity({
    type: "activity",
    status: "success",
    stage: "finalize",
    title: "Done",
    detail: "AutoRouter execution",
    items: [{action: "Produced", target: `${stageResults.length} stage results`}]
  });

  return {
    lines: [
      ...finalAnswer.content.split(/\r?\n/),
      "",
      ...buildCostReviewLines({execution, stageResults, finalAnswer})
    ]
  };
}

function buildCostReviewLines({execution, stageResults, finalAnswer}) {
  const items = [
    {
      prefix: "planning: analyze task",
      label: execution.baseModel,
      usageText: execution.baseModelUsageText ?? "usage unavailable"
    },
    ...stageResults.map((result, index) => ({
      prefix: `stage ${index + 1}: ${stripMarkdown(result.stage)}`,
      label: result.modelLabel,
      usageText: result.usageText
    })),
    ...(finalAnswer.usageText
      ? [{
          prefix: "final: synthesize answer",
          label: finalAnswer.modelLabel,
          usageText: finalAnswer.usageText
        }]
      : [])
  ];
  const costs = items.map((item) => parseDollarText(item.usageText));
  const totalCost = costs.reduce((total, cost) => Number.isFinite(cost) ? total + cost : total, 0);
  const hasTotal = costs.some((cost) => Number.isFinite(cost));

  return [
    "[Cost Review]",
    ...items.map((item, index) => {
      const cost = costs[index];
      const usageText = formatUsageWithShare(item.usageText, cost, totalCost);
      return `${item.prefix} (${item.label}, ${usageText})`;
    }),
    hasTotal ? `total: ${formatDollarCost(totalCost)}` : "total: cost unavailable"
  ];
}

function formatUsageWithShare(usageText, cost, totalCost) {
  if (!Number.isFinite(cost) || totalCost <= 0) {
    return usageText;
  }

  const percentage = (cost / totalCost) * 100;
  return `${usageText}/${percentage.toFixed(1)}%`;
}

async function synthesizeFinalAnswer({config, execution, stageResults, signal}) {
  const finalModel =
    [...stageResults].reverse().find((result) => getProviderConfig(config, result.provider)) ??
    [...(execution.routes ?? [])].reverse().find((route) => getProviderConfig(config, route.provider));

  if (!finalModel) {
    return {
      content: stripMarkdown(stageResults.map((result) => result.content).join("\n\n")) || "No stage results were produced.",
      modelLabel: "",
      usageText: ""
    };
  }

  const provider = getProviderConfig(config, finalModel.provider);

  if (!provider) {
    return {
      content: stripMarkdown(stageResults.map((result) => result.content).join("\n\n")),
      modelLabel: "",
      usageText: ""
    };
  }

  try {
    const response = await callChatCompletion({
      providerName: finalModel.provider,
      provider,
      modelName: finalModel.modelName,
      messages: buildFinalAnswerMessages(execution.task, stageResults),
      maxTokens: MAX_FINAL_ANSWER_TOKENS,
      thinking: "disabled",
      signal
    });

    return {
      content: stripMarkdown(response.content.trim()),
      modelLabel: finalModel.modelLabel,
      usageText: formatUsageCost(response.usage, finalModel) || "usage unavailable"
    };
  } catch (error) {
    return {
      content: stripMarkdown(stageResults.map((result) => result.content).join("\n\n")) || "Final synthesis failed and no stage results were produced.",
      modelLabel: finalModel.modelLabel,
      usageText: `final synthesis unavailable: ${getErrorMessage(error)}`
    };
  }
}

function buildStageExecutionMessages(task, route, previousResults) {
  const boundedTask = limitInputText(task, MAX_TASK_INPUT_CHARS);
  const previous = previousResults.length === 0
    ? "None"
    : previousResults
        .map((result, index) => `${index + 1}. ${result.stage}: ${limitInputText(result.content, getStageResultContextLimit(result))}`)
        .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "You are an AutoRouter execution model.",
        "Complete only the assigned stage.",
        "Do not claim to edit files, run shell commands, browse, or call tools.",
        "Do not invent current facts. If current external data is missing, say what data is missing.",
        "Return concise, directly useful text for the next stage."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        getRuntimeContext(),
        "",
        `Original task:\n${boundedTask}`,
        "",
        `Assigned stage: ${route.stage}`,
        `Stage kind: ${route.kind}`,
        route.goal ? `Stage goal: ${route.goal}` : "",
        "",
        `Previous stage results:\n${previous}`
      ].filter(Boolean).join("\n")
    }
  ];
}

function buildFileEditMessages(task, route, previousResults, codebaseResult) {
  const boundedTask = limitInputText(task, MAX_TASK_INPUT_CHARS);
  const previous = previousResults.length === 0
    ? "None"
    : previousResults
        .map((result, index) => `${index + 1}. ${result.stage}: ${limitInputText(result.content, getStageResultContextLimit(result))}`)
        .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "You are an AutoRouter local file edit planner.",
        "Return only JSON.",
        "Plan exact text replacements for existing local files.",
        "Do not include shell commands.",
        "Use only files visible in the local workspace context.",
        "Use small, exact old text snippets that appear once in the target file when possible.",
        "Do not edit secrets, .env files, lockfiles, node_modules, build output, or hidden VCS files.",
        "If no safe exact replacement can be planned, return {\"edits\":[],\"note\":\"...\"}.",
        "JSON shape:",
        "{\"edits\":[{\"file\":\"relative/path.js\",\"old\":\"exact old text\",\"new\":\"exact new text\",\"description\":\"short reason\"}]}"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        getRuntimeContext(),
        "",
        `Original task:\n${boundedTask}`,
        "",
        `Assigned stage: ${route.stage}`,
        `Stage kind: ${route.kind}`,
        route.goal ? `Stage goal: ${route.goal}` : "",
        "",
        `Previous stage results:\n${previous}`,
        "",
        `Local workspace context:\n${codebaseResult.content}`
      ].filter(Boolean).join("\n")
    }
  ];
}

function buildFileWriteMessages(task, route, previousResults, codebaseResult) {
  const boundedTask = limitInputText(task, MAX_TASK_INPUT_CHARS);
  const previous = previousResults.length === 0
    ? "None"
    : previousResults
        .map((result, index) => `${index + 1}. ${result.stage}: ${limitInputText(result.content, getStageResultContextLimit(result))}`)
        .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "You are an AutoRouter local file creation planner.",
        "Return only JSON.",
        "Plan new file writes for the current working directory.",
        "Do not include shell commands.",
        "Use relative file paths under the current working directory.",
        "Create only files needed by the user's task.",
        "Do not write secrets, .env files, lockfiles, node_modules, build output, or hidden VCS files.",
        "If no safe file creation can be planned, return {\"files\":[],\"note\":\"...\"}.",
        "JSON shape:",
        "{\"files\":[{\"file\":\"relative/path.md\",\"content\":\"full file content\",\"description\":\"short reason\"}]}"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        getRuntimeContext(),
        "",
        `Original task:\n${boundedTask}`,
        "",
        `Assigned stage: ${route.stage}`,
        `Stage kind: ${route.kind}`,
        route.goal ? `Stage goal: ${route.goal}` : "",
        "",
        `Previous stage results:\n${previous}`,
        "",
        `Local workspace context:\n${codebaseResult.content}`
      ].filter(Boolean).join("\n")
    }
  ];
}

function buildFinalAnswerMessages(task, stageResults) {
  const boundedTask = limitInputText(task, MAX_TASK_INPUT_CHARS);
  const context = stageResults
    .map((result, index) =>
      [
        `Stage ${index + 1}: ${result.stage}`,
        `Model: ${result.modelLabel}`,
        `Result: ${limitInputText(result.content, getStageResultContextLimit(result))}`
      ].join("\n")
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "You are AutoRouter's final answer writer.",
        "Answer the user's original question directly.",
        "If the user asked multiple things, answer every part.",
        "Use the stage results as working context, but do not mention internal stages.",
        "Do not invent current facts. If the stage results do not contain enough current external data, say what is missing.",
        "Do not use Markdown formatting.",
        "Do not use bullets, asterisks, bold markers, headings, or code fences.",
        "Write concise plain text."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        getRuntimeContext(),
        "",
        `Original question:\n${boundedTask}`,
        "",
        `Stage results:\n${context}`
      ].join("\n")
    }
  ];
}

function getStageResultContextLimit(result) {
  if (result.modelName?.includes("exa.search")) {
    return 3000;
  }

  if (result.modelName?.includes("local.codebase")) {
    return 6000;
  }

  return MAX_STAGE_RESULT_CHARS;
}
