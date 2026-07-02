export const CONFIG_FILE = "autorouter.config.json";
export const LOCAL_ENV_FILE = ".env.local";
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const EXA_DEFAULT_BASE_URL = "https://api.exa.ai";
export const OPENAI_COMPATIBLE_PROVIDERS = new Set(["openai", "deepseek", "kimi"]);

export const KIMI_K27_CODE_PRICING = {inputCacheHitPerMillion: 0.19, inputCacheMissPerMillion: 0.95, outputPerMillion: 4};
export const KIMI_K27_CODE_HIGHSPEED_PRICING = {inputCacheHitPerMillion: 0.38, inputCacheMissPerMillion: 1.9, outputPerMillion: 8};
export const KIMI_K26_PRICING = {inputCacheHitPerMillion: 0.16, inputCacheMissPerMillion: 0.95, outputPerMillion: 4};
export const KIMI_K25_PRICING = {inputCacheHitPerMillion: 0.1, inputCacheMissPerMillion: 0.6, outputPerMillion: 3};
export const MOONSHOT_V1_8K_PRICING = {inputPerMillion: 0.2, outputPerMillion: 2};
export const MOONSHOT_V1_32K_PRICING = {inputPerMillion: 1, outputPerMillion: 3};
export const MOONSHOT_V1_128K_PRICING = {inputPerMillion: 2, outputPerMillion: 5};

export const MAX_TASK_INPUT_CHARS = 2000;
export const MAX_STAGE_RESULT_CHARS = 600;
export const MAX_FINAL_ANSWER_TOKENS = 500;
export const MAX_LOCAL_FILE_CHARS = 4000;
export const MAX_CODEBASE_CONTEXT_CHARS = 14000;
export const MAX_WORKSPACE_SNAPSHOT_FILES = 80;
export const MAX_FILE_EDIT_RESPONSE_TOKENS = 1200;
export const MAX_FILE_EDITS_PER_STAGE = 6;
export const MAX_FILE_WRITE_RESPONSE_TOKENS = 1200;
export const MAX_FILE_WRITES_PER_STAGE = 6;

export const localCodebaseTool = "local_files";
export const fileEditTool = "file_edit";
export const fileWriteTool = "file_write";
export const allowedStageTools = new Set(["web_search", localCodebaseTool, fileEditTool, fileWriteTool]);
