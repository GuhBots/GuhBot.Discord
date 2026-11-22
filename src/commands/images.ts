import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  type CommandInteraction,
  type User,
} from "discord.js";
import { Discord, Guard, Slash, SlashOption } from "discordx";
import { Category } from "@discordx/utilities";
import sharp from "sharp";
import { assetPath } from "../config.js";
import { fetchAvatar } from "../lib/avatar.js";
import { GUILD_ONLY } from "../lib/categories.js";
import { Cooldown } from "../lib/cooldown.js";

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** Where each template expects the avatar, in pixels. */
const ROSS_AVATAR = { size: 69, left: 4, top: 70 };
const TRASH_AVATAR = { size: 200, left: 117, top: 127 };

/**
 * Rotates an image counterclockwise by `angle` degrees and crops it back to
 * its original size, as Pillow's default rotate did in the original bot.
 */
async function rotateInPlace(image: Buffer, angle: number): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  // Pillow rotates counterclockwise and sharp rotates clockwise.
  const rotated = await sharp(image).rotate(-angle, { background: TRANSPARENT }).png().toBuffer();
  const { width: rotatedWidth = 0, height: rotatedHeight = 0 } = await sharp(rotated).metadata();
  return sharp(rotated)
    .extract({
      left: Math.floor((rotatedWidth - width) / 2),
      top: Math.floor((rotatedHeight - height) / 2),
      width,
      height,
    })
    .png()
    .toBuffer();
}

/** Pastes a resized avatar onto a template image from `assets/images/`. */
async function pasteAvatar(
  template: string,
  avatar: Buffer,
  { size, left, top }: { size: number; left: number; top: number },
): Promise<Buffer> {
  const resized = await sharp(avatar).resize(size, size).png().toBuffer();
  return sharp(assetPath(`images/${template}`))
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer();
}

const memberOption = {
  name: "member",
  description: "Whose avatar to use (default you)",
  type: ApplicationCommandOptionType.User,
  required: false,
} as const;

@Discord()
@Category("Images")
export class Images {
  /** Downloads the avatar, transforms it, and replies with the result as `project.png`. */
  private async replyWithImage(
    interaction: CommandInteraction,
    user: User | undefined,
    transform: (avatar: Buffer) => Promise<Buffer>,
    content?: string,
  ): Promise<void> {
    await interaction.deferReply();
    const image = await transform(await fetchAvatar(user ?? interaction.user));
    await interaction.editReply({
      content,
      files: [new AttachmentBuilder(image, { name: "project.png" })],
    });
  }

  @Slash({ name: "australia", description: "Traveling in a fried-out Kombi", ...GUILD_ONLY })
  @Guard(Cooldown(10))
  async australia(
    @SlashOption(memberOption) user: User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await this.replyWithImage(interaction, user, (avatar) => rotateInPlace(avatar, 180));
  }

  @Slash({ name: "rotate", description: "Rotate a profile picture", ...GUILD_ONLY })
  @Guard(Cooldown(10))
  async rotate(
    @SlashOption(memberOption) user: User | undefined,
    @SlashOption({
      name: "angle",
      description: "Degrees to rotate counterclockwise (default 0)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: -360,
      maxValue: 360,
    })
    angle: number | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await this.replyWithImage(interaction, user, (avatar) => rotateInPlace(avatar, angle ?? 0));
  }

  @Slash({ name: "grayscale", description: "Black and white images", ...GUILD_ONLY })
  @Guard(Cooldown(10))
  async grayscale(
    @SlashOption(memberOption) user: User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await this.replyWithImage(interaction, user, (avatar) =>
      sharp(avatar).grayscale().png().toBuffer(),
    );
  }

  @Slash({ name: "ross", description: "Get a load of this guy", ...GUILD_ONLY })
  @Guard(Cooldown(10))
  async ross(
    @SlashOption(memberOption) user: User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await this.replyWithImage(
      interaction,
      user,
      (avatar) => pasteAvatar("ross.png", avatar, ROSS_AVATAR),
      "Get a load of this guy",
    );
  }

  @Slash({ name: "trash", description: "Recycle bin maybe?", ...GUILD_ONLY })
  @Guard(Cooldown(10))
  async trash(
    @SlashOption(memberOption) user: User | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    await this.replyWithImage(interaction, user, (avatar) =>
      pasteAvatar("trash.png", avatar, TRASH_AVATAR),
    );
  }
}
