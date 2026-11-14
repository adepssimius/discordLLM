import type { Config } from "./config.js";
import type { Domain } from "./definition.js";
import type { ApprovalDesk } from "./discord/approvals.js";
import type { SessionManager } from "./session/manager.js";
import type { WorkspaceProvider } from "./workspace.js";

/**
 * One profile, assembled: its settings, the bot's domain for it, where its
 * agent stands, and its session manager. The bot holds one of these per
 * profile and picks the right one from the channel a message arrived in, or
 * from the profile stamped on a session.
 */
export interface Profile {
  readonly cfg: Config;
  readonly domain: Domain;
  readonly workspace: WorkspaceProvider;
  readonly manager: SessionManager;
  /** Present once Discord is; the REPL has none. */
  readonly desk?: ApprovalDesk;
}

export class Profiles {
  constructor(private readonly list: readonly Profile[]) {
    if (list.length === 0) throw new Error("at least one profile is required");
  }

  get all(): readonly Profile[] {
    return this.list;
  }

  get first(): Profile {
    return this.list[0]!;
  }

  /**
   * The profile a stored row names. A row from before profiles were named
   * says `default`; if no profile is called that any more, the first one
   * takes it — which is a single-profile installation being renamed, not a
   * conflict.
   */
  named(name: string): Profile {
    return this.list.find((p) => p.cfg.name === name) ?? this.first;
  }

  /**
   * The profile that owns a channel. With one profile and no channel list,
   * every channel is its own. With several profiles, a channel belongs to
   * whichever lists it, and a profile listing no channel owns none.
   */
  forChannel(channelId: string): Profile | undefined {
    if (this.list.length === 1 && this.first.cfg.DISCORD_CHAT_CHANNEL_IDS.length === 0) return this.first;
    return this.list.find((p) => p.cfg.DISCORD_CHAT_CHANNEL_IDS.includes(channelId));
  }

  /** Every channel any profile answers in; empty means any channel (single profile, no list). */
  get channels(): readonly string[] {
    if (this.list.length === 1 && this.first.cfg.DISCORD_CHAT_CHANNEL_IDS.length === 0) return [];
    return this.list.flatMap((p) => p.cfg.DISCORD_CHAT_CHANNEL_IDS);
  }
}
