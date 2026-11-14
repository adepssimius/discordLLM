#!/usr/bin/env node
import { resolve } from "node:path";
import { runChat } from "./chat.js";
import { configBot, loadBotFile } from "./configbot.js";
import { fatal, run } from "./run.js";

/**
 * Runs a bot from a file, with no code of its own:
 *
 *   discordllm [start] [bot.json]    the bot, in Discord
 *   discordllm chat [bot.json]       the same bot, from stdin
 *
 * The file defaults to $BOT_FILE, then ./discordllm.json. See configbot.ts
 * for its shape.
 */
const args = process.argv.slice(2);
const mode = args[0] === "chat" || args[0] === "start" ? args.shift()! : "start";
const path = resolve(args[0] ?? process.env.BOT_FILE ?? "discordllm.json");

(async () => {
  const def = configBot(loadBotFile(path));
  await (mode === "chat" ? runChat(def) : run(def));
})().catch(fatal);
