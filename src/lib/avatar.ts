import type { User } from "discord.js";

const AVATAR_SIZE = 128;

/** Downloads a user's avatar as a static 128-pixel PNG, as the original image commands did. */
export async function fetchAvatar(user: User): Promise<Buffer> {
  const url = user.displayAvatarURL({ extension: "png", forceStatic: true, size: AVATAR_SIZE });
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Avatar download failed with status ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
