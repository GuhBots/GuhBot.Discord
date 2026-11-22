import type { CommandInteraction } from "discord.js";
import { RateLimit, TIME_UNIT } from "@discordx/utilities";

/** Formats a wait the way the original bot did, such as "1 minutes and 5 seconds". */
export function formatWait(milliseconds: number): string {
  const totalSeconds = milliseconds / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours === 0 && minutes === 0) {
    return `${seconds.toFixed(2)} seconds`;
  }
  if (hours === 0) {
    return `${minutes} minutes and ${Math.floor(seconds)} seconds`;
  }
  return `${hours} hours, ${minutes} minutes and ${Math.floor(seconds)} seconds`;
}

/**
 * Limits each user to `uses` runs of a command per `seconds`, in each guild.
 * Use it with discordx's `@Guard`.
 */
export function Cooldown(seconds: number, uses = 1) {
  return RateLimit<CommandInteraction>(TIME_UNIT.seconds, seconds, {
    rateValue: uses,
    ephemeral: true,
    message: (interaction, timeLeft) =>
      `Slow down ${interaction.user}! You must wait \`${formatWait(timeLeft)}\` to use this command!`,
  });
}
