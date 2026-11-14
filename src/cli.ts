#!/usr/bin/env node
import { resolve } from "node:path";
import { runChat, showPrompt } from "./chat.js";
import { configBot, loadBotFile } from "./configbot.js";
import { fatal, run } from "./run.js";

/**
 * Runs a bot from a file, with no code of its own:
 *
 *   discordllm [start] [bot.json]    the bot, in Discord
 *   discordllm chat [bot.json]       the same bot, from stdin
 *   discordllm prompt [bot.json]     what the agent is told; --brief for a scheduled run
 *
 * The file defaults to $BOT_FILE, then ./discordllm.json. See configbot.ts
 * for its shape.
 */
const all = process.argv.slice(2);
const brief = all.includes("--brief");
const args = all.filter((a) => a !== "--brief");
const mode = args[0] === "chat" || args[0] === "start" || args[0] === "prompt" ? args.shift()! : "start";
const path = resolve(args[0] ?? process.env.BOT_FILE ?? "discordllm.json");

(async () => {
  const def = configBot(loadBotFile(path));
  if (mode === "prompt") await showPrompt(def, { brief });
  else await (mode === "chat" ? runChat(def) : run(def));
})().catch(fatal);
