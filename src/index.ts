/**
 * discordllm — a Discord bot backed by Claude that works through MCP servers.
 *
 * A bot is a `defineBot({...})` and two three-line entry points:
 *
 *   // main.ts                      // chat.ts
 *   import { main } from "discordllm";   import { chat } from "discordllm";
 *   import bot from "./bot.js";     import bot from "./bot.js";
 *   main(bot);                      chat(bot);
 */

export { defineBot, parseToolName, toolCall, ALLOW, deny } from "./definition.js";
export type {
  BotDefinition,
  Classification,
  Decision,
  Domain,
  DomainTurn,
  PolicyCall,
  SetupContext,
  ToolCall,
  TurnInfo,
} from "./definition.js";

export { main, run, fatal } from "./run.js";
export { chat, runChat, showPrompt } from "./chat.js";
export { renderPromptReport, promptSummary, type PromptReport } from "./inspect.js";
export { configBot, loadBotFile, BotFileSchema } from "./configbot.js";
export type { BotFile } from "./configbot.js";

export { bool, boolDefaultTrue, csv, optionalString, ConfigError, DEFAULT_BUILTIN_TOOLS, INBOX_DIR } from "./config.js";
export type { Config, CoreConfig, ProfileConfig } from "./config.js";

export {
  NO_APPROVAL,
  DEFAULT_TIERS,
  approvalLevels,
  classifyByName,
  defaultApprovalLevel,
  isReadTier,
  isTopTier,
  needsApproval,
} from "./agent/tiers.js";
export type { NameRules } from "./agent/tiers.js";

export { confined, confinePathArgs, fieldString, inside, PATHLIKE_KEY, evaluate as evaluatePolicy } from "./agent/policy.js";
export type { PolicyInput, PolicyRules } from "./agent/policy.js";
export { sections, localStamp, BOT_SERVER, BRIEF_ONLY_LOOKS } from "./agent/prompts.js";
export type { SectionContext } from "./agent/prompts.js";

export { sharedWorkspace, pruneOlderThan, NOTES_FILE } from "./workspace.js";
export type { SharedWorkspace, SharedWorkspaceOptions, WorkspaceProvider } from "./workspace.js";

export type { Phrasebook } from "./discord/activity.js";
export type { Logger } from "./logger.js";
export type { Session, Schedule, SessionKind } from "./session/types.js";

// The seam to the model. `claudeAgent()` is the default; anything else that
// implements `AgentBackend` can be passed as `defineBot({ backend })`.
export { tool } from "./agent/backend.js";
export type {
  AgentBackend,
  AgentOutcome,
  AgentRun,
  AgentSink,
  Authorization,
  McpServer,
  RateLimitInfo,
  ToolDefinition,
  ToolGuard,
  ToolResult,
} from "./agent/backend.js";
export { claudeAgent } from "./backends/claude/index.js";
export type { ImageBlock } from "./agent/images.js";

// Names from before the backend seam, kept so existing bots compile unchanged.
export type { McpServer as McpServerConfig, ToolDefinition as SdkMcpToolDefinition } from "./agent/backend.js";

// Re-exported so a bot's schemas are built with the copy of zod the library runs on.
export { z } from "zod";
