import React, {useEffect, useRef, useState} from "react";
import {Box, Static, Text, render, useApp, useInput, useStdout} from "ink";
import {
  MAX_TASK_INPUT_CHARS
} from "./constants.js";
import {initConfig, loadConfig, loadLocalEnv} from "./config.js";
import {formatUsageCost} from "./costs.js";
import {runExecution} from "./execution.js";
import {callChatCompletion} from "./providers/chat.js";
import {
  getAvailableModelChoices,
  getEnabledModelById,
  getEnabledModels,
  getModelInventoryForPrompt,
  getProviderConfig,
  isProviderAvailable,
  normalizeBaseModel,
  parseModelId
} from "./providers/inventory.js";
import {
  normalizeAnalyzedStages,
  normalizeClarificationQuestion,
  validateStageModelIds
} from "./router/analysis.js";
import {getWorkspaceSnapshotForAnalysis} from "./tools/local-files.js";
import {
  getErrorMessage,
  limitInputText,
  normalizeInsertedText,
  parseJsonObject,
  stripMarkdown,
  truncateText,
  wrapPlainText
} from "./utils/text.js";
import {getRuntimeContext} from "./utils/runtime.js";
import {VoiceCapture} from "./voice/recorder.js";
import {OrderedAsyncQueue} from "./voice/queue.js";
import {getVoiceAvailabilityError, transcribePcm} from "./voice/transcription.js";

const h = React.createElement;
const promptGutterWidth = 2;
const inputVerticalPadding = 1;
const modelColor = "#007c91";
const pathColor = "#6d5dfc";
const successColor = "#00a676";
const errorColor = "#ff3864";
const costColor = "#b23aee";
const voiceModes = [
  {id: "off", label: "Off", description: "Disable microphone input"},
  {id: "key", label: "Press Tab and talk", description: "Tab starts one utterance"},
  {id: "free", label: "Speak freely", description: "Continuously detect utterances"}
];
const slashCommands = [
  {
    id: "voice",
    name: "voice",
    displayText: "/voice",
    description: "Choose voice input mode"
  },
  {
    id: "model",
    name: "model",
    displayText: "/model",
    description: "Choose base model"
  },
  {
    id: "help",
    name: "help",
    displayText: "/help",
    description: "Show commands"
  },
  {
    id: "exit",
    name: "exit",
    displayText: "/exit",
    description: "Close AutoRouter"
  },
  {
    id: "quit",
    name: "quit",
    displayText: "/quit",
    description: "Close AutoRouter"
  }
];

export function main() {
  loadLocalEnv();

  const command = process.argv[2];

  if (command === "init") {
    initConfig();
    return;
  }

  render(h(AutoRouterApp, {config: loadConfig()}), {exitOnCtrlC: false});
}


function AutoRouterApp({config}) {
  const {exit} = useApp();
  const availableModelChoices = getAvailableModelChoices(config);
  const [selectedBaseModel, setSelectedBaseModel] = useState(availableModelChoices[0] ?? null);
  const [promptHistory, setPromptHistory] = useState([]);
  const [entries, setEntries] = useState(() => [
    {
      id: "intro",
      type: "text",
      lines: [
        "AutoRouter",
        "Type /model to choose a base model, /voice for dictation, /help for commands, or enter a task."
      ]
    }
  ]);
  const [mode, setMode] = useState("chat");
  const [voiceMode, setVoiceMode] = useState("off");
  const [autoApproveExecution, setAutoApproveExecution] = useState(false);
  const [pendingExecution, setPendingExecution] = useState(null);
  const [pendingClarification, setPendingClarification] = useState(null);

  const appendEntry = (entry) => {
    setEntries((current) => [...current, {...entry, id: `${Date.now()}-${current.length}`}]);
  };

  const appendEntries = (nextEntries) => {
    setEntries((current) => [
      ...current,
      ...nextEntries.map((entry, index) => ({
        ...entry,
        id: `${Date.now()}-${current.length + index}`
      }))
    ]);
  };

  const handleSubmit = (value) => {
    const text = value.trim();

    if (!text) {
      return;
    }

    if (text === "/exit" || text === "/quit") {
      exit();
      return;
    }

    recordPromptHistory(text);

    if (text === "/help") {
      appendEntries([
        {type: "user", text},
        {
          type: "text",
          lines: [
            "Commands",
            "1. /model           Open model picker",
            "2. /model <number>  Choose model by number",
            "3. /voice           Choose voice input mode",
            "4. /voice <number>  Choose voice mode by number",
            "5. /help            Show commands",
            "6. /exit            Close AutoRouter",
            "",
            "Use Shift+Enter or a trailing backslash before Enter for a new line."
          ]
        }
      ]);
      return;
    }

    if (text === "/model") {
      appendEntry({type: "user", text});
      setMode("model");
      return;
    }

    if (text.startsWith("/model ")) {
      const nextModel = chooseBaseModelByInput(text.slice(7).trim(), config, selectedBaseModel);
      setSelectedBaseModel(nextModel);
      appendEntries([
        {type: "user", text},
        {type: "text", lines: [nextModel ? `Base model: ${nextModel.label}` : "No available base model. Add a provider API key in .env.local."]}
      ]);
      return;
    }

    if (text === "/voice") {
      appendEntry({type: "user", text});
      setMode("voice");
      return;
    }

    if (text.startsWith("/voice ")) {
      const nextVoiceMode = chooseVoiceModeByInput(text.slice(7).trim());
      appendEntry({type: "user", text});

      if (!nextVoiceMode) {
        appendEntry({type: "text", lines: ["Unknown voice mode. Use /voice to choose Off, Press Tab and talk, or Speak freely."]});
        return;
      }

      selectVoiceMode(nextVoiceMode);
      return;
    }

    appendEntry({type: "user", text});

    if (pendingClarification) {
      const clarifiedTask = buildClarifiedTask(pendingClarification.task, pendingClarification.question, text);
      setPendingClarification(null);
      routeTask(clarifiedTask);
      return;
    }

    routeTask(text);
  };

  const routeTask = async (text) => {
    setMode("routing");

    const routerEntry = await buildRouterEntry(text, config, selectedBaseModel, !autoApproveExecution);
    appendEntry(routerEntry);

    if (routerEntry.type !== "router" && routerEntry.type !== "clarification") {
      setPendingExecution(null);
      setPendingClarification(null);
      setMode("chat");
      return;
    }

    if (routerEntry.type === "clarification") {
      setPendingClarification({
        task: text,
        question: routerEntry.question
      });
      setMode("chat");
      return;
    }

    setPendingClarification(null);

    if (autoApproveExecution) {
      startExecution(routerEntry);
      return;
    }

    setPendingExecution(routerEntry);
    setMode("approval");
  };

  const approveExecution = (rememberForSession) => {
    if (rememberForSession) {
      setAutoApproveExecution(true);
      appendEntry({
        type: "text",
        lines: ["Execution approved.", "Future execution will be accepted automatically for this session."]
      });
    } else {
      appendEntry({type: "text", lines: ["Execution approved."]});
    }

    startExecution(pendingExecution);
  };

  const startExecution = (execution) => {
    if (!execution) {
      setMode("chat");
      return;
    }

    setPendingExecution(execution);
    setMode("executing");
  };

  const finishExecution = (result) => {
    appendEntry({type: "result", lines: result?.lines ?? ["No output produced."]});
    setPendingExecution(null);
    setMode("chat");
  };

  const interruptExecution = () => {
    appendEntry({type: "text", lines: ["Execution interrupted."]});
    setPendingExecution(null);
    setMode("chat");
  };

  const requestExecutionFeedback = () => {
    setMode("feedback");
  };

  const submitExecutionFeedback = (feedback) => {
    const text = feedback.trim();

    if (!text) {
      return;
    }

    appendEntries([
      {type: "user", text},
      {type: "text", lines: ["Execution canceled.", `AutoRouter should: ${text}`]}
    ]);
    setPendingExecution(null);
    setMode("chat");
  };

  const selectVoiceMode = (nextVoiceMode) => {
    if (nextVoiceMode !== "off") {
      const availabilityError = getVoiceAvailabilityError(config);

      if (availabilityError) {
        setVoiceMode("off");
        appendEntry({type: "text", lines: [availabilityError]});
        setMode("chat");
        return;
      }
    }

    setVoiceMode(nextVoiceMode);
    appendEntry({type: "text", lines: [`Voice input: ${getVoiceModeLabel(nextVoiceMode)}`]});
    setMode("chat");
  };

  return h(
    Box,
    {flexDirection: "column"},
    h(Static, {items: entries}, (entry) => h(TranscriptEntry, {key: entry.id, entry})),
    mode === "model"
      ? h(ModelPicker, {
          config,
          currentModel: selectedBaseModel,
          onCancel: () => setMode("chat"),
          onSelect: (model) => {
            setSelectedBaseModel(model);
            appendEntry({type: "text", lines: [`Base model: ${model.label}`]});
            setMode("chat");
          }
        })
      : mode === "voice"
        ? h(VoicePicker, {
            currentMode: voiceMode,
            onCancel: () => setMode("chat"),
            onSelect: selectVoiceMode
          })
      : mode === "routing"
        ? h(WorkingStatus, {label: "Routing", detail: selectedBaseModel?.label ?? "base model"})
      : mode === "approval"
        ? h(ExecutionApproval, {
            pendingExecution,
            onApprove: () => approveExecution(false),
            onApproveSession: () => approveExecution(true),
            onReject: requestExecutionFeedback
          })
        : mode === "executing"
          ? h(ExecutionRunner, {
              config,
              execution: pendingExecution,
              onEvent: appendEntry,
              onDone: finishExecution,
              onCancel: interruptExecution
            })
        : mode === "feedback"
          ? h(ExecutionFeedbackEditor, {
              onSubmit: submitExecutionFeedback,
              onCancel: () => {
                appendEntry({type: "text", lines: ["Execution canceled."]});
                setPendingExecution(null);
                setMode("chat");
              }
            })
      : h(PromptEditor, {
          config,
          selectedBaseModel,
          voiceMode,
          promptHistory,
          onSubmit: handleSubmit,
          onExit: exit
        })
  );

  function recordPromptHistory(text) {
    setPromptHistory((current) => {
      if (current.at(-1) === text) {
        return current;
      }

      return [...current, text].slice(-100);
    });
  }
}

function buildClarifiedTask(originalTask, clarificationQuestion, clarificationAnswer) {
  return [
    "Original task:",
    originalTask,
    "",
    "Clarification question:",
    clarificationQuestion,
    "",
    "Clarification answer:",
    clarificationAnswer
  ].join("\n");
}

function TranscriptEntry({entry}) {
  if (entry.type === "user") {
    return h(UserPromptEntry, {entry});
  }

  if (entry.type === "router") {
    return h(RouterResponseEntry, {entry});
  }

  if (entry.type === "clarification") {
    return h(ClarificationEntry, {entry});
  }

  if (entry.type === "text") {
    if (entry.id !== "intro") {
      return h(TextResponseEntry, {entry});
    }

    return h(
      Box,
      {flexDirection: "column", marginBottom: 1},
      ...entry.lines.map((line, index) => h(Text, {key: index, dimColor: index === 1 && entry.id === "intro"}, line))
    );
  }

  if (entry.type === "result") {
    return h(ResultEntry, {entry});
  }

  if (entry.type === "activity") {
    return h(ActivityEntry, {entry});
  }

  return null;
}

function TextResponseEntry({entry}) {
  const {stdout} = useStdout();
  const width = Math.max(20, stdout.columns ?? 80);
  const contentWidth = getResponseContentWidth(width);
  const lines = entry.lines.flatMap((line) => wrapPlainText(line, contentWidth));

  return h(
    Box,
    {flexDirection: "column", marginBottom: 1},
    ...lines.map((line, index) =>
      line === ""
        ? h(ResponseLine, {key: index}, h(Text, null, ""))
        : h(ResponseLine, {key: index}, h(Text, null, line))
    )
  );
}

function ResultEntry({entry}) {
  const {stdout} = useStdout();
  const width = Math.max(20, stdout.columns ?? 80);
  const contentWidth = Math.max(20, width);
  const lines = entry.lines.flatMap((line) => wrapPlainText(line, contentWidth));

  return h(
    Box,
    {flexDirection: "column", marginBottom: 1},
    ...lines.map((line, index) =>
      h(Text, {key: index, color: isCostReviewLine(line) ? costColor : undefined}, line === "" ? " " : line)
    )
  );
}

function isCostReviewLine(line) {
  return line === "[Cost Review]" || line.startsWith("planning:") || line.startsWith("stage ") || line.startsWith("final:") || line.startsWith("total:");
}

function UserPromptEntry({entry}) {
  const {stdout} = useStdout();
  const terminalWidth = Math.max(20, stdout.columns ?? 80);
  const inputWidth = getSafeInputWidth(terminalWidth, promptGutterWidth);

  return h(
    Box,
    {flexDirection: "column", marginTop: 1, marginBottom: 1},
    h(InputPanel, {
      value: entry.text,
      cursorOffset: null,
      width: inputWidth,
      gutterWidth: promptGutterWidth
    })
  );
}

function ClarificationEntry({entry}) {
  return h(TextResponseEntry, {entry: {lines: [entry.question]}});
}

function RouterResponseEntry({entry}) {
  return h(
    Box,
    {flexDirection: "column", marginBottom: 1},
    h(ResponseLine, null, h(Text, {color: modelColor}, "AutoRouter")),
    h(ResponseLine, null, h(Text, null, `Base model: ${entry.baseModel}`)),
    h(ResponseLine, null, h(Text, null, "Stages")),
    ...entry.routes.flatMap((route, index) => getRoutePreviewLines(route, index).map((line, lineIndex) => h(
      ResponseLine,
      {key: `${route.stage}-${index}-${lineIndex}`},
      h(Text, {dimColor: lineIndex > 0}, line)
    ))),
    h(ResponseLine, null, h(Text, null, entry.approvalRequired ? "Waiting for execution approval." : "Execution approved for this session."))
  );
}

export function getRoutePreviewLines(route, index) {
  const lines = [
    `${index + 1}. ${route.stage}`,
    `model: ${route.modelLabel}`
  ];

  if (route.tools?.length) {
    lines.push(`tool: ${route.tools.join(", ")}`);
  }

  if (route.modelChoiceReason) {
    lines.push(`reason: ${route.modelChoiceReason}`);
  }

  return lines;
}

function ResponseLine({children}) {
  return h(
    Box,
    {flexDirection: "row"},
    h(Text, {dimColor: true}, "  | "),
    h(Box, {flexShrink: 1}, children)
  );
}

function ActivityEntry({entry}) {
  const bulletColor = entry.status === "error" ? errorColor : entry.status === "success" ? successColor : modelColor;

  return h(
    Box,
    {flexDirection: "column", marginBottom: 1},
    h(
      Box,
      {flexDirection: "row"},
      h(Text, {color: bulletColor}, "• "),
      h(Text, {bold: true}, entry.title),
      entry.detail ? h(Text, {dimColor: true}, ` ${entry.detail}`) : null
    ),
    ...entry.items.map((item, index) =>
      h(
        Box,
        {key: index, flexDirection: "row", paddingLeft: 2},
        h(Text, {dimColor: true}, "└ "),
        h(Text, {color: item.color ?? undefined}, item.action),
        h(Text, null, ` ${item.target}`),
        item.detail ? h(Text, {dimColor: true}, ` ${item.detail}`) : null
      )
    )
  );
}

function WorkingStatus({label, detail}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return h(
    Box,
    {flexDirection: "column", marginTop: 1},
    h(
      Text,
      null,
      h(Text, {color: successColor}, "• "),
      h(Text, {bold: true}, label),
      h(Text, {dimColor: true}, ` (${elapsedSeconds}s) · ${detail}`)
    )
  );
}

function ExecutionRunner({config, execution, onEvent, onDone, onCancel}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [currentStage, setCurrentStage] = useState("starting");
  const onEventRef = useRef(onEvent);
  const onDoneRef = useRef(onDone);
  const onCancelRef = useRef(onCancel);

  onEventRef.current = onEvent;
  onDoneRef.current = onDone;
  onCancelRef.current = onCancel;

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancelRef.current();
    }
  });

  useEffect(() => {
    if (!execution) {
      onDoneRef.current();
      return undefined;
    }

    const abortController = new AbortController();
    let isCanceled = false;
    const startedAt = Date.now();
    const elapsedTimer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);

    runExecution({
      config,
      execution,
      signal: abortController.signal,
      onActivity: (activity) => {
        setCurrentStage(activity.stage);
        onEventRef.current(activity);
      }
    })
      .then((result) => {
        if (!isCanceled) {
          onDoneRef.current(result);
        }
      })
      .catch((error) => {
        if (isCanceled || abortController.signal.aborted) {
          return;
        }

        onEventRef.current({
          type: "activity",
          status: "error",
          stage: "execution failed",
          title: "Failed",
          detail: "DeepSeek API",
          items: [{action: "Error", target: getErrorMessage(error)}]
        });
        onDoneRef.current({lines: ["Execution failed.", getErrorMessage(error)]});
      });

    return () => {
      isCanceled = true;
      abortController.abort();
      clearInterval(elapsedTimer);
    };
  }, [config, execution]);

  return h(
    Box,
    {flexDirection: "column", marginTop: 1},
    h(
      Text,
      null,
      h(Text, {color: successColor}, "• "),
      h(Text, {bold: true}, "Working"),
      h(Text, {dimColor: true}, ` (${elapsedSeconds}s · esc to interrupt) · ${currentStage}`)
    )
  );
}

function ExecutionApproval({pendingExecution, onApprove, onApproveSession, onReject}) {
  const options = [
    {value: "yes", label: "Yes"},
    {value: "yes-session", label: "Yes, and accept all execution this session"},
    {value: "no", label: "No. Tell AutoRouter what to do instead"}
  ];
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (input === "1") {
      onApprove();
      return;
    }

    if (input === "2") {
      onApproveSession();
      return;
    }

    if (input === "3") {
      onReject();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((index) => (index === 0 ? options.length - 1 : index - 1));
      return;
    }

    if (key.downArrow || key.tab) {
      setSelectedIndex((index) => (index === options.length - 1 ? 0 : index + 1));
      return;
    }

    if (key.return) {
      const selected = options[selectedIndex]?.value;

      if (selected === "yes") {
        onApprove();
        return;
      }

      if (selected === "yes-session") {
        onApproveSession();
        return;
      }

      onReject();
    }
  });

  return h(
    Box,
    {flexDirection: "column", borderStyle: "round", borderColor: modelColor, borderLeft: false, borderRight: false, borderBottom: false, marginTop: 1, paddingX: 1},
    h(Text, {color: modelColor}, "AutoRouter needs approval to execute"),
    h(Text, {dimColor: true}, pendingExecution ? `Task: ${pendingExecution.task}` : "Review the routed plan before execution."),
    h(Text, null, ""),
    ...options.map((option, index) =>
      h(
        Text,
        {key: option.value, color: index === selectedIndex ? modelColor : undefined, dimColor: index !== selectedIndex},
        `${index === selectedIndex ? ">" : " "} ${index + 1}. ${option.label}`
      )
    ),
    h(Text, null, ""),
    h(Text, {dimColor: true}, "Use arrows, number keys, or Enter.")
  );
}

function ExecutionFeedbackEditor({onSubmit, onCancel}) {
  const {stdout} = useStdout();
  const terminalWidth = Math.max(20, stdout.columns ?? 80);
  const width = getSafeInputWidth(terminalWidth);
  const [editor, setEditorState] = useState({value: "", cursorOffset: 0});
  const editorRef = useRef(editor);

  function setEditor(nextEditor) {
    editorRef.current = nextEditor;
    setEditorState(nextEditor);
  }

  useInput((input, key) => {
    const {value, cursorOffset} = editorRef.current;

    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }

    if (key.return) {
      onSubmit(value);
      setEditor({value: "", cursorOffset: 0});
      return;
    }

    if (key.backspace || input === "\u007f") {
      if (cursorOffset === 0) {
        return;
      }

      setEditor({
        value: `${value.slice(0, cursorOffset - 1)}${value.slice(cursorOffset)}`,
        cursorOffset: cursorOffset - 1
      });
      return;
    }

    if (key.delete) {
      if (cursorOffset >= value.length) {
        return;
      }

      setEditor({
        value: `${value.slice(0, cursorOffset)}${value.slice(cursorOffset + 1)}`,
        cursorOffset
      });
      return;
    }

    if (key.leftArrow) {
      setEditor({value, cursorOffset: Math.max(0, cursorOffset - 1)});
      return;
    }

    if (key.rightArrow) {
      setEditor({value, cursorOffset: Math.min(value.length, cursorOffset + 1)});
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const coalescedSubmit = getCoalescedSubmitText(input);

      if (coalescedSubmit !== null) {
        const next = coalescedSubmit.replace(/\n/g, " ");
        const submittedValue = `${value.slice(0, cursorOffset)}${next}${value.slice(cursorOffset)}`;
        onSubmit(submittedValue);
        setEditor({value: "", cursorOffset: 0});
        return;
      }

      const next = normalizeInsertedText(input).replace(/\n/g, " ");
      setEditor({
        value: `${value.slice(0, cursorOffset)}${next}${value.slice(cursorOffset)}`,
        cursorOffset: cursorOffset + next.length
      });
    }
  });

  return h(
    Box,
    {flexDirection: "column", marginTop: 1},
    h(Text, {color: modelColor}, "Tell AutoRouter what to do instead"),
    h(Text, {dimColor: true}, "Press Enter to submit. Esc cancels."),
    h(InputPanel, {value: editor.value, cursorOffset: editor.cursorOffset, width})
  );
}

function PromptEditor({config, selectedBaseModel, voiceMode, promptHistory, onSubmit, onExit}) {
  const {stdout} = useStdout();
  const terminalWidth = Math.max(20, stdout.columns ?? 80);
  const inputWidth = getSafeInputWidth(terminalWidth, promptGutterWidth);
  const [editor, setEditorState] = useState({value: "", cursorOffset: 0});
  const [selectedSuggestion, setSelectedSuggestionState] = useState(0);
  const editorRef = useRef(editor);
  const promptHistoryRef = useRef(promptHistory);
  const historyIndexRef = useRef(0);
  const historyDraftRef = useRef(null);
  const selectedSuggestionRef = useRef(0);
  const previousSuggestionsKey = useRef("");
  const voiceCaptureRef = useRef(null);
  const voiceGenerationRef = useRef(0);
  const insertTranscriptionRef = useRef(() => {});
  const transcriptionQueueRef = useRef(new OrderedAsyncQueue());
  const transcriptionControllersRef = useRef(new Set());
  const pendingTranscriptionsRef = useRef(0);
  const captureStatusRef = useRef(voiceMode === "key" ? "ready" : voiceMode === "free" ? "listening" : "off");
  const voiceErrorRef = useRef(null);
  const mountedRef = useRef(true);
  const [voiceActivity, setVoiceActivity] = useState(() => getVoiceActivityLabel(voiceMode, captureStatusRef.current, 0));
  const suggestions = getCommandSuggestionsForInput(editor.value, editor.cursorOffset);
  const suggestionsKey = suggestions.map((suggestion) => suggestion.id).join("|");
  promptHistoryRef.current = promptHistory;

  function setEditor(nextEditor, options = {}) {
    if (options.resetHistory !== false) {
      resetPromptHistoryNavigation();
    }

    editorRef.current = nextEditor;
    setEditorState(nextEditor);
  }

  function setSelectedSuggestion(nextIndex) {
    selectedSuggestionRef.current = nextIndex;
    setSelectedSuggestionState(nextIndex);
  }

  useEffect(() => {
    if (previousSuggestionsKey.current !== suggestionsKey) {
      previousSuggestionsKey.current = suggestionsKey;
      setSelectedSuggestion(0);
      return;
    }

    if (suggestions.length > 0 && selectedSuggestion >= suggestions.length) {
      setSelectedSuggestion(suggestions.length - 1);
    }
  }, [selectedSuggestion, suggestions.length, suggestionsKey]);

  useEffect(() => {
    const handleSigint = () => {
      if (editorRef.current.value.length > 0) {
        setEditor({value: "", cursorOffset: 0});
        return;
      }

      onExit();
    };

    process.on("SIGINT", handleSigint);
    return () => {
      process.off("SIGINT", handleSigint);
    };
  }, [onExit]);

  useEffect(() => {
    mountedRef.current = true;
    const generation = voiceGenerationRef.current + 1;
    voiceGenerationRef.current = generation;
    voiceErrorRef.current = null;
    transcriptionQueueRef.current = new OrderedAsyncQueue();
    captureStatusRef.current = voiceMode === "key" ? "ready" : voiceMode === "free" ? "listening" : "off";
    refreshVoiceActivity();

    if (voiceMode === "free") {
      startVoiceCapture(true, generation);
    }

    return () => {
      mountedRef.current = false;
      voiceGenerationRef.current += 1;
      voiceCaptureRef.current?.stop();
      voiceCaptureRef.current = null;

      for (const controller of transcriptionControllersRef.current) {
        controller.abort();
      }

      transcriptionControllersRef.current.clear();
      pendingTranscriptionsRef.current = 0;
      transcriptionQueueRef.current.close();
    };
  }, [voiceMode]);

  useInput((input, key) => {
    const {value, cursorOffset} = editorRef.current;
    const activeSuggestions = getCurrentCommandSuggestions();

    if (key.escape && voiceMode === "key" && voiceCaptureRef.current?.isRunning) {
      voiceCaptureRef.current.stop();
      voiceCaptureRef.current = null;
      captureStatusRef.current = "ready";
      voiceErrorRef.current = null;
      refreshVoiceActivity();
      return;
    }

    if ((key.ctrl && input === "c") || input === "\u0003") {
      if (editorRef.current.value.length > 0) {
        setEditor({value: "", cursorOffset: 0});
        return;
      }

      onExit();
      return;
    }

    if (key.ctrl && input === "d" && value.length === 0) {
      onExit();
      return;
    }

    if (key.return) {
      if (activeSuggestions.length > 0 && applySelectedCommandSuggestion(true)) {
        return;
      }

      if (value[cursorOffset - 1] === "\\") {
        const next = `${value.slice(0, cursorOffset - 1)}\n${value.slice(cursorOffset)}`;
        setEditor({value: next, cursorOffset});
        return;
      }

      if (key.shift || key.meta) {
        insertText("\n");
        return;
      }

      submitEditorValue(value);
      setEditor({value: "", cursorOffset: 0}, {resetHistory: false});
      resetPromptHistoryNavigation();
      return;
    }

    if (key.tab || input === "\t") {
      if (voiceMode === "key" && !voiceCaptureRef.current?.isRunning && pendingTranscriptionsRef.current === 0) {
        startVoiceCapture(false, voiceGenerationRef.current);
      }

      return;
    }

    if (key.backspace || input === "\u007f") {
      if (cursorOffset === 0) {
        return;
      }

      setEditor({
        value: `${value.slice(0, cursorOffset - 1)}${value.slice(cursorOffset)}`,
        cursorOffset: cursorOffset - 1
      });
      return;
    }

    if (key.delete) {
      if (cursorOffset >= value.length) {
        return;
      }

      setEditor({
        value: `${value.slice(0, cursorOffset)}${value.slice(cursorOffset + 1)}`,
        cursorOffset
      });
      return;
    }

    if (key.leftArrow) {
      setEditor({value, cursorOffset: Math.max(0, cursorOffset - 1)}, {resetHistory: false});
      return;
    }

    if (key.rightArrow) {
      setEditor({value, cursorOffset: Math.min(value.length, cursorOffset + 1)}, {resetHistory: false});
      return;
    }

    if (key.upArrow) {
      if (activeSuggestions.length > 0) {
        const nextIndex = selectedSuggestionRef.current === 0 ? activeSuggestions.length - 1 : selectedSuggestionRef.current - 1;
        setSelectedSuggestion(nextIndex);
        return;
      }

      if (moveCursorOrHistory(value, cursorOffset, -1)) {
        return;
      }

      showPreviousPromptFromHistory();
      return;
    }

    if (key.downArrow) {
      if (activeSuggestions.length > 0) {
        const nextIndex = selectedSuggestionRef.current === activeSuggestions.length - 1 ? 0 : selectedSuggestionRef.current + 1;
        setSelectedSuggestion(nextIndex);
        return;
      }

      if (moveCursorOrHistory(value, cursorOffset, 1)) {
        return;
      }

      showNextPromptFromHistory();
      return;
    }

    if (key.ctrl && input === "a") {
      setEditor({value, cursorOffset: getLineStartOffset(value, cursorOffset)}, {resetHistory: false});
      return;
    }

    if (key.ctrl && input === "e") {
      setEditor({value, cursorOffset: getLineEndOffset(value, cursorOffset)}, {resetHistory: false});
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const coalescedSubmit = getCoalescedSubmitText(input);

      if (coalescedSubmit !== null) {
        insertText(coalescedSubmit);
        const submittedValue = editorRef.current.value;
        submitEditorValue(submittedValue);
        setEditor({value: "", cursorOffset: 0}, {resetHistory: false});
        resetPromptHistoryNavigation();
        return;
      }

      insertText(normalizeInsertedText(input));
    }
  });

  function insertText(text) {
    const {value, cursorOffset} = editorRef.current;
    const nextEditor = {
      value: `${value.slice(0, cursorOffset)}${text}${value.slice(cursorOffset)}`,
      cursorOffset: cursorOffset + text.length
    };
    setEditor(nextEditor);
    return nextEditor;
  }

  insertTranscriptionRef.current = (text) => {
    const {value, cursorOffset} = editorRef.current;
    const nextEditor = insertDictationText(value, cursorOffset, text);
    setEditor(nextEditor);
  };

  function startVoiceCapture(continuous, generation) {
    if (voiceCaptureRef.current?.isRunning || generation !== voiceGenerationRef.current) {
      return;
    }

    voiceErrorRef.current = null;
    const capture = new VoiceCapture({
      onStatus: (status) => {
        if (generation !== voiceGenerationRef.current || !mountedRef.current) {
          return;
        }

        captureStatusRef.current = status;
        refreshVoiceActivity();
      },
      onUtterance: (utterance) => {
        if (generation !== voiceGenerationRef.current || !mountedRef.current) {
          return;
        }

        if (!continuous) {
          voiceCaptureRef.current = null;
          captureStatusRef.current = "ready";
        }

        queueTranscription(utterance, generation);
      },
      onNoSpeech: () => {
        if (generation !== voiceGenerationRef.current || !mountedRef.current) {
          return;
        }

        voiceCaptureRef.current = null;
        captureStatusRef.current = "ready";
        voiceErrorRef.current = "No speech detected";
        refreshVoiceActivity();
      },
      onError: (error) => {
        if (generation !== voiceGenerationRef.current || !mountedRef.current) {
          return;
        }

        voiceCaptureRef.current = null;
        captureStatusRef.current = voiceMode === "key" ? "ready" : "off";
        voiceErrorRef.current = getErrorMessage(error);
        refreshVoiceActivity();
      }
    });

    voiceCaptureRef.current = capture;
    capture.start({continuous});
  }

  function queueTranscription(utterance, generation) {
    const controller = new AbortController();
    transcriptionControllersRef.current.add(controller);
    pendingTranscriptionsRef.current += 1;
    refreshVoiceActivity();

    const request = transcribePcm({
      ...utterance,
      config,
      signal: controller.signal
    });

    transcriptionQueueRef.current.enqueue(request, {
      onSuccess: (result) => {
        if (generation === voiceGenerationRef.current && mountedRef.current) {
          insertTranscriptionRef.current(result.text);
          voiceErrorRef.current = null;
        }
      },
      onError: (error) => {
        if (!controller.signal.aborted && generation === voiceGenerationRef.current && mountedRef.current) {
          voiceErrorRef.current = getErrorMessage(error);
        }
      },
      onSettled: () => {
        transcriptionControllersRef.current.delete(controller);
        pendingTranscriptionsRef.current = Math.max(0, pendingTranscriptionsRef.current - 1);

        if (generation === voiceGenerationRef.current && mountedRef.current) {
          refreshVoiceActivity();
        }
      }
    });
  }

  function refreshVoiceActivity() {
    if (!mountedRef.current) {
      return;
    }

    setVoiceActivity(
      getVoiceActivityLabel(
        voiceMode,
        captureStatusRef.current,
        pendingTranscriptionsRef.current,
        voiceErrorRef.current
      )
    );
  }

  function moveCursorOrHistory(value, cursorOffset, direction) {
    const nextOffset = moveCursorVertically(value, cursorOffset, direction);

    if (nextOffset === cursorOffset) {
      return false;
    }

    setEditor({value, cursorOffset: nextOffset}, {resetHistory: false});
    return true;
  }

  function showPreviousPromptFromHistory() {
    const history = promptHistoryRef.current;

    if (history.length === 0) {
      return;
    }

    const targetIndex = historyIndexRef.current;

    if (targetIndex === 0) {
      const current = editorRef.current.value;
      historyDraftRef.current = current.trim() ? current : null;
    }

    const nextHistoryIndex = targetIndex + 1;
    const promptIndex = history.length - nextHistoryIndex;

    if (promptIndex < 0) {
      return;
    }

    const value = history[promptIndex];
    historyIndexRef.current = nextHistoryIndex;
    setEditor({value, cursorOffset: 0}, {resetHistory: false});
  }

  function showNextPromptFromHistory() {
    const historyIndex = historyIndexRef.current;

    if (historyIndex <= 0) {
      return;
    }

    if (historyIndex > 1) {
      const nextHistoryIndex = historyIndex - 1;
      const value = promptHistoryRef.current[promptHistoryRef.current.length - nextHistoryIndex] ?? "";
      historyIndexRef.current = nextHistoryIndex;
      setEditor({value, cursorOffset: value.length}, {resetHistory: false});
      return;
    }

    const value = historyDraftRef.current ?? "";
    historyIndexRef.current = 0;
    historyDraftRef.current = null;
    setEditor({value, cursorOffset: value.length}, {resetHistory: false});
  }

  function resetPromptHistoryNavigation() {
    historyIndexRef.current = 0;
    historyDraftRef.current = null;
  }

  function getCurrentCommandSuggestions() {
    const currentEditor = editorRef.current;
    return getCommandSuggestionsForInput(currentEditor.value, currentEditor.cursorOffset);
  }

  function getSelectedCommandSuggestion(commandSuggestions) {
    if (commandSuggestions.length === 0) {
      return null;
    }

    const selectedIndex = Math.min(selectedSuggestionRef.current, commandSuggestions.length - 1);
    return commandSuggestions[selectedIndex] ?? null;
  }

  function applySelectedCommandSuggestion(shouldExecute) {
    const commandSuggestions = getCurrentCommandSuggestions();
    const suggestion = getSelectedCommandSuggestion(commandSuggestions);

    if (!suggestion) {
      return false;
    }

    if (shouldExecute) {
      onSubmit(`/${suggestion.name}`);
      setEditor({value: "", cursorOffset: 0}, {resetHistory: false});
      resetPromptHistoryNavigation();
      return true;
    }

    const nextValue = `/${suggestion.name} `;
    setEditor({value: nextValue, cursorOffset: nextValue.length});
    return true;
  }

  function submitEditorValue(value) {
    const commandSuggestions = getCommandSuggestionsForInput(value, value.length);

    if (commandSuggestions.length > 0) {
      const exactSuggestion = commandSuggestions.find((suggestion) => suggestion.displayText === value.trim());
      const selected = exactSuggestion ?? getSelectedCommandSuggestion(commandSuggestions);

      if (selected) {
        onSubmit(`/${selected.name}`);
        return;
      }
    }

    onSubmit(value);
  }

  return h(
    Box,
    {flexDirection: "column"},
    h(InputPanel, {value: editor.value, cursorOffset: editor.cursorOffset, width: inputWidth, gutterWidth: promptGutterWidth}),
    h(CommandSuggestions, {suggestions, selectedSuggestion, width: inputWidth, gutterWidth: promptGutterWidth}),
    h(StatusLine, {selectedBaseModel, voiceMode, voiceActivity})
  );
}

function CommandSuggestions({suggestions, selectedSuggestion, width, gutterWidth = 0}) {
  if (suggestions.length === 0) {
    return null;
  }

  const maxVisibleItems = 6;
  const startIndex = Math.max(0, Math.min(selectedSuggestion - Math.floor(maxVisibleItems / 2), suggestions.length - maxVisibleItems));
  const visibleSuggestions = suggestions.slice(startIndex, startIndex + maxVisibleItems);
  const nameWidth = Math.min(
    Math.max(...suggestions.map((suggestion) => suggestion.displayText.length)) + 4,
    Math.floor(width * 0.4)
  );

  return h(
    Box,
    {flexDirection: "column", paddingLeft: gutterWidth},
    ...visibleSuggestions.map((suggestion) => {
      const isSelected = suggestion.id === suggestions[selectedSuggestion]?.id;
      const paddedName = truncateText(suggestion.displayText, Math.max(1, nameWidth - 1)).padEnd(nameWidth, " ");
      const descriptionWidth = Math.max(0, width - nameWidth - 2);
      const description = truncateText(suggestion.description, descriptionWidth);

      return h(
        Text,
        {key: suggestion.id, wrap: "truncate"},
        h(Text, {color: isSelected ? modelColor : undefined, dimColor: !isSelected}, paddedName),
        h(Text, {color: isSelected ? modelColor : undefined, dimColor: !isSelected}, description)
      );
    })
  );
}

function InputPanel({value, cursorOffset, width, gutterWidth = 0, paddingY = inputVerticalPadding}) {
  const rawLines = value.split("\n");
  const cursor = cursorOffset === null ? null : getCursorPosition(value, cursorOffset);
  const visualLines = getInputVisualLines(rawLines, cursor, width);

  return h(
    Box,
    {flexDirection: "column", paddingLeft: gutterWidth},
    ...Array.from({length: paddingY}, (_unused, index) =>
      h(InputSpacerLine, {key: `top-${index}`})
    ),
    ...visualLines.map((line, index) =>
      h(InputLine, {
        key: index,
        line: line.text,
        width,
        isFirstLine: line.isFirstLine,
        cursorColumn: line.cursorColumn
      })
    ),
    ...Array.from({length: paddingY}, (_unused, index) =>
      h(InputSpacerLine, {key: `bottom-${index}`})
    )
  );
}

function getInputVisualLines(rawLines, cursor, width) {
  const contentWidth = Math.max(1, width - 2);
  const visualLines = [];

  rawLines.forEach((line, logicalLineIndex) => {
    const cursorColumn = cursor && cursor.line === logicalLineIndex ? cursor.column : null;
    const segmentCount = Math.max(1, Math.ceil(line.length / contentWidth));
    const needsCursorOverflowLine =
      cursorColumn !== null &&
      cursorColumn === line.length &&
      line.length > 0 &&
      line.length % contentWidth === 0;
    const totalSegments = segmentCount + (needsCursorOverflowLine ? 1 : 0);

    for (let segmentIndex = 0; segmentIndex < totalSegments; segmentIndex += 1) {
      const start = segmentIndex * contentWidth;
      const text = line.slice(start, start + contentWidth);
      const cursorInSegment =
        cursorColumn !== null &&
        cursorColumn >= start &&
        cursorColumn <= start + contentWidth &&
        (segmentIndex === totalSegments - 1 || cursorColumn < start + contentWidth)
          ? cursorColumn - start
          : null;

      visualLines.push({
        text,
        isFirstLine: logicalLineIndex === 0 && segmentIndex === 0,
        cursorColumn: cursorInSegment
      });
    }
  });

  return visualLines;
}

function InputSpacerLine() {
  return h(Text, null, " ");
}

function InputLine({line, width, isFirstLine, cursorColumn}) {
  const rendered = formatInputLine(line, width, isFirstLine, cursorColumn);

  return h(Text, null, rendered);
}

export function formatInputLine(line, width, isFirstLine, cursorColumn) {
  const safeWidth = Math.max(1, Math.floor(width));
  const prefix = isFirstLine ? "> " : "  ";
  const text = `${prefix}${line}`;
  const cursorIndex = cursorColumn === null ? -1 : prefix.length + cursorColumn;
  const clipped = text.slice(0, safeWidth);
  return cursorIndex >= 0 && cursorIndex < safeWidth
    ? `${clipped.slice(0, cursorIndex)}▌${clipped.slice(cursorIndex + 1)}`
    : clipped;
}

export function getSafeInputWidth(terminalWidth, gutterWidth = 0) {
  const columns = Math.max(1, Math.floor(terminalWidth));
  const gutter = Math.max(0, Math.floor(gutterWidth));
  return Math.max(1, columns - gutter - 1);
}

function StatusLine({selectedBaseModel, voiceMode = "off", voiceActivity = "off"}) {
  const model = selectedBaseModel ? formatPromptModelName(selectedBaseModel.label) : "no-model";
  const cwd = formatPromptPath(process.cwd());
  const voiceColor = voiceActivity === "recording" ? errorColor : voiceActivity.startsWith("error:") ? errorColor : successColor;

  return h(
    Box,
    {paddingLeft: 2},
    h(Text, {color: modelColor}, model),
    h(Text, {dimColor: true}, " · "),
    h(Text, {color: pathColor}, cwd),
    h(Text, {dimColor: true}, " · "),
    h(Text, {color: voiceMode === "off" ? undefined : voiceColor, dimColor: voiceMode === "off"}, `voice: ${voiceActivity}`)
  );
}

function VoicePicker({currentMode, onSelect, onCancel}) {
  const currentIndex = voiceModes.findIndex((mode) => mode.id === currentMode);
  const [selectedIndex, setSelectedIndex] = useState(currentIndex >= 0 ? currentIndex : 0);

  useInput((input, key) => {
    if (/^[1-3]$/.test(input)) {
      const mode = voiceModes[Number.parseInt(input, 10) - 1];

      if (mode) {
        onSelect(mode.id);
      }

      return;
    }

    if (key.upArrow) {
      setSelectedIndex((index) => (index === 0 ? voiceModes.length - 1 : index - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((index) => (index === voiceModes.length - 1 ? 0 : index + 1));
      return;
    }

    if (key.return) {
      onSelect(voiceModes[selectedIndex].id);
      return;
    }

    if (key.escape) {
      onCancel();
    }
  });

  return h(
    Box,
    {flexDirection: "column", marginTop: 1},
    h(Text, null, "Choose voice input mode"),
    ...voiceModes.map((mode, index) => {
      const isHighlighted = index === selectedIndex;
      const current = mode.id === currentMode ? " (current)" : "";

      return h(
        Text,
        {key: mode.id, color: isHighlighted ? modelColor : undefined, dimColor: !isHighlighted},
        `${isHighlighted ? ">" : " "} ${index + 1}. ${mode.label}${current} · ${mode.description}`
      );
    }),
    h(Text, null, ""),
    h(Text, {dimColor: true}, "Use arrow keys or number keys. Enter selects. Esc cancels.")
  );
}

function ModelPicker({config, currentModel, onSelect, onCancel}) {
  const models = getAvailableModelChoices(config);
  const currentIndex = models.findIndex((model) => model.id === currentModel?.id);
  const [selectedIndex, setSelectedIndex] = useState(currentIndex >= 0 ? currentIndex : 0);

  useInput((input, key) => {
    if (models.length === 0) {
      if (key.escape || key.return) {
        onCancel();
      }
      return;
    }

    if (/^[1-9]$/.test(input)) {
      const nextIndex = Number.parseInt(input, 10) - 1;

      if (models[nextIndex]) {
        onSelect(models[nextIndex]);
      }

      return;
    }

    if (key.upArrow) {
      setSelectedIndex((index) => (index === 0 ? models.length - 1 : index - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((index) => (index === models.length - 1 ? 0 : index + 1));
      return;
    }

    if (key.return) {
      onSelect(models[selectedIndex]);
      return;
    }

    if (key.escape) {
      onCancel();
    }
  });

  return h(
    Box,
    {flexDirection: "column", marginTop: 1},
    h(Text, null, "Choose base model"),
    ...(models.length === 0
      ? [
          h(Text, {key: "empty"}, "No available base models."),
          h(Text, {key: "hint", dimColor: true}, "Add an enabled provider API key to .env.local, then restart AutoRouter.")
        ]
      : models.map((model, index) => {
      const isHighlighted = index === selectedIndex;
      const current = model.id === currentModel?.id ? " (current)" : "";
      return h(
        Text,
        {key: model.id, color: isHighlighted ? modelColor : undefined, dimColor: !isHighlighted},
        `${isHighlighted ? ">" : " "} ${index + 1}. ${model.label}${current}`
      );
        })),
    h(Text, null, ""),
    h(Text, {dimColor: true}, "Use arrow keys. Enter selects. Esc cancels.")
  );
}

function chooseBaseModelByInput(inputText, config, fallback) {
  const index = Number.parseInt(inputText, 10) - 1;
  const models = getAvailableModelChoices(config);
  return models[index] ?? fallback ?? models[0] ?? null;
}

export function chooseVoiceModeByInput(inputText) {
  const normalized = String(inputText ?? "").trim().toLowerCase();
  const aliases = {
    "1": "off",
    off: "off",
    "2": "key",
    key: "key",
    tab: "key",
    "3": "free",
    free: "free"
  };
  return aliases[normalized] ?? null;
}

function getVoiceModeLabel(mode) {
  return voiceModes.find((item) => item.id === mode)?.label ?? "Off";
}

export function getVoiceActivityLabel(mode, captureStatus, pendingTranscriptions = 0, error = null) {
  if (error) {
    return `error: ${error}`;
  }

  if (mode === "off") {
    return "off";
  }

  if (pendingTranscriptions > 0) {
    return mode === "free" ? "listening · transcribing" : "transcribing";
  }

  if (captureStatus === "recording") {
    return "recording";
  }

  if (mode === "free") {
    return "listening";
  }

  return "Tab to talk";
}

export function insertDictationText(value, cursorOffset, transcript) {
  const text = String(transcript ?? "").replace(/\s+/g, " ").trim();

  if (!text) {
    return {value, cursorOffset};
  }

  const before = value.slice(0, cursorOffset);
  const after = value.slice(cursorOffset);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before) && !/^[,.;:!?)]/.test(text);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after) && !/^[,.;:!?)]/.test(after);
  const inserted = `${needsLeadingSpace ? " " : ""}${text}${needsTrailingSpace ? " " : ""}`;

  return {
    value: `${before}${inserted}${after}`,
    cursorOffset: cursorOffset + inserted.length
  };
}

export async function buildRouterEntry(prompt, config, selectedBaseModel, approvalRequired = true) {
  const analysis = await analyzeTaskWithBaseModel(prompt, config, selectedBaseModel);

  if (analysis.error) {
    return {
      type: "text",
      lines: [`Base model analysis failed: ${analysis.error}`]
    };
  }

  if (analysis.clarificationQuestion) {
    return {
      type: "clarification",
      task: prompt,
      analyzer: analysis.analyzer,
      question: analysis.clarificationQuestion
    };
  }

  const stages = analysis.stages;
  const routes = stages.map((stage) => {
    const model = getEnabledModelById(config, stage.modelId);
    return {
      stage: stage.label,
      kind: stage.kind,
      goal: stage.goal ?? "",
      tools: stage.tools ?? [],
      modelLabel: model?.label ?? "No enabled model",
      modelName: model?.model ?? parseModelId(model?.id).model,
      provider: model?.provider ?? "none",
      apiKeyEnv: model?.apiKeyEnv ?? "",
      pricing: model?.pricing ?? null,
      maxTokens: model?.maxTokens ?? 700,
      modelChoiceReason: stage.modelChoiceReason
    };
  });

  return {
    type: "router",
    task: prompt,
    baseModel: selectedBaseModel?.label ?? "No base model",
    baseModelUsageText: formatUsageCost(analysis.usage, selectedBaseModel) || "usage unavailable",
    analyzer: analysis.analyzer,
    approvalRequired,
    routes
  };
}

async function analyzeTaskWithBaseModel(prompt, config, selectedBaseModel) {
  if (!selectedBaseModel) {
    return {error: "no available base model. Add a provider API key to .env.local and restart AutoRouter"};
  }

  const baseModel = normalizeBaseModel(selectedBaseModel);
  const provider = getProviderConfig(config, baseModel.provider);
  const enabledModels = getEnabledModels(config);

  if (!isProviderAvailable(config, baseModel.provider, provider)) {
    return {error: `base model provider is not available: ${baseModel.provider}`};
  }

  if (enabledModels.length === 0) {
    return {error: "no enabled execution models configured"};
  }

  try {
    const response = await callChatCompletion({
      providerName: baseModel.provider,
      provider,
      modelName: baseModel.model,
      messages: buildStageAnalysisMessages(prompt, config),
      json: true,
      maxTokens: baseModel.maxTokens ?? 800,
      thinking: "disabled"
    });
    const parsed = parseJsonObject(response.content);

    if (parsed?.error) {
      return {error: String(parsed.error).trim().slice(0, 240) || "base model returned an error"};
    }

    const modelClarificationQuestion = normalizeClarificationQuestion(parsed);

    if (modelClarificationQuestion) {
      return {
        analyzer: `${selectedBaseModel?.label ?? baseModel.model} API`,
        clarificationQuestion: modelClarificationQuestion,
        usage: response.usage
      };
    }

    const stages = normalizeAnalyzedStages(parsed?.stages);
    const modelValidationError = validateStageModelIds(stages, enabledModels);

    if (modelValidationError) {
      return {error: modelValidationError};
    }

    if (stages.length === 0) {
      return {error: "base model returned no valid stages"};
    }

    return {
      analyzer: `${selectedBaseModel?.label ?? baseModel.model} API`,
      stages,
      usage: response.usage
    };
  } catch (error) {
    return {error: getErrorMessage(error)};
  }
}

function buildStageAnalysisMessages(prompt, config) {
  const boundedPrompt = limitInputText(prompt, MAX_TASK_INPUT_CHARS);
  const modelInventory = getModelInventoryForPrompt(config);
  const workspaceSnapshot = getWorkspaceSnapshotForAnalysis(process.cwd());

  return [
    {
      role: "system",
      content: [
        "You are AutoRouter's base model. Return only JSON.",
        "Goal: decide whether to clarify, fail, or split the task into execution stages.",
        "Clarify first if a missing requirement materially affects the task plan, model choice, tool choice, safety, cost, or final answer quality.",
        "Do not guess or infer missing requirements.",
        "Clarification response shape: {\"clarification\":\"What detail should I use to proceed?\"}.",
        "If no configured execution model can handle the task, return {\"error\":\"...\"}.",
        "If the task is clear, return {\"stages\":[...]} with 1 to 6 stages. Simple questions can be one stage.",
        "Each stage must include label, kind, goal, modelId, and modelChoiceReason. tools is optional.",
        "Use only modelId values from availableModels. Choose by task fit, capability, context length, speed, and cost.",
        "modelChoiceReason must be one concise sentence explaining the model choice over alternatives. Do not include hidden reasoning.",
        "Allowed tools: web_search for live external facts; local_files for current workspace reads; file_write for new local files; file_edit for editing local files.",
        "Use tools only when needed. Add local_files with file_edit when edit context is needed.",
        "For this project, this repo, current folder, cwd, or folder where you are, use the current working directory and workspace snapshot. Do not ask for a repository link."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        getRuntimeContext(),
        "",
        `Local workspace snapshot:\n${workspaceSnapshot}`,
        "",
        `availableModels:\n${JSON.stringify(modelInventory, null, 2)}`,
        "",
        `Task:\n${boundedPrompt}`
      ].join("\n")
    }
  ];
}


function getResponseContentWidth(terminalWidth) {
  return Math.max(20, terminalWidth - 6);
}


function getCommandSuggestionsForInput(value, cursorOffset) {
  if (!value.startsWith("/") || cursorOffset === 0 || value.includes("\n")) {
    return [];
  }

  const beforeCursor = value.slice(0, cursorOffset);
  const afterCursor = value.slice(cursorOffset);

  if (beforeCursor.includes(" ") || afterCursor.includes(" ") || !/^\/[a-zA-Z0-9_-]*$/.test(value)) {
    return [];
  }

  const query = value.slice(1).toLowerCase();

  if (query === "") {
    return slashCommands;
  }

  const exactMatches = [];
  const prefixMatches = [];
  const subtextMatches = [];

  for (const command of slashCommands) {
    const name = command.name.toLowerCase();
    const displayText = command.displayText.toLowerCase();
    const description = command.description.toLowerCase();

    if (name === query) {
      exactMatches.push(command);
      continue;
    }

    if (name.startsWith(query)) {
      prefixMatches.push(command);
      continue;
    }

    if (name.includes(query) || displayText.includes(query) || description.includes(query)) {
      subtextMatches.push(command);
    }
  }

  prefixMatches.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  subtextMatches.sort((a, b) => a.name.localeCompare(b.name));
  return [...exactMatches, ...prefixMatches, ...subtextMatches];
}


function getCoalescedSubmitText(text) {
  const normalized = text.replace(/\r/g, "\n");

  if (
    normalized.length > 1 &&
    normalized.endsWith("\n") &&
    !normalized.slice(0, -1).includes("\n") &&
    normalized[normalized.length - 2] !== "\\"
  ) {
    return normalized.slice(0, -1);
  }

  return null;
}

function getCursorPosition(value, offset) {
  const before = value.slice(0, offset);
  const lines = before.split("\n");
  return {
    line: lines.length - 1,
    column: lines.at(-1)?.length ?? 0
  };
}

function moveCursorVertically(value, offset, direction) {
  const lines = value.split("\n");
  const position = getCursorPosition(value, offset);
  const nextLine = position.line + direction;

  if (nextLine < 0 || nextLine >= lines.length) {
    return offset;
  }

  const nextColumn = Math.min(position.column, lines[nextLine].length);
  return getOffsetFromPosition(lines, nextLine, nextColumn);
}

function getOffsetFromPosition(lines, lineIndex, column) {
  let offset = 0;

  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index].length + 1;
  }

  return offset + column;
}

function getLineStartOffset(value, offset) {
  return value.lastIndexOf("\n", offset - 1) + 1;
}

function getLineEndOffset(value, offset) {
  const nextNewline = value.indexOf("\n", offset);
  return nextNewline === -1 ? value.length : nextNewline;
}

function formatPromptModelName(label) {
  return label.toLowerCase().replaceAll(" ", "-");
}

function formatPromptPath(cwd) {
  const home = process.env.HOME;

  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}
