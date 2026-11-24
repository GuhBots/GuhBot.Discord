import { join } from "node:path";
import sharp from "sharp";
import { createArchive, updateArchiveSettings } from "../../../src/archivist/archives.js";
import { createArtifact } from "../../../src/archivist/artifacts.js";
import type { ArchivistContext } from "../../../src/archivist/context.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
  updateEntity,
} from "../../../src/archivist/entities.js";
import { createEvent } from "../../../src/archivist/events.js";
import { addHistory } from "../../../src/archivist/history.js";
import { createStagingFolder, discardStaging, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
import { createRequest } from "../../../src/archivist/requests.js";
import { MEMBER, OWNER } from "../helpers/context.js";

/**
 * A small made-up archive for browser checks: characters with avatars and
 * history, a main server with channels, a second server, a group chat,
 * dated and undated artifacts, events of each kind, and a missing-media
 * request. Everything is generated, so nothing real is committed.
 */

const COLORS = [
  "#5865f2",
  "#eb459e",
  "#00a8fc",
  "#f0b232",
  "#a970ff",
  "#2dc7c4",
  "#ff7a45",
  "#e67e22",
  "#c9cdfb",
];

async function image(context: ArchivistContext, color: string, name: string, size = [320, 240]) {
  const folder = createStagingFolder(context);
  const file = join(folder, "original");
  await sharp({ create: { width: size[0]!, height: size[1]!, channels: 3, background: color } })
    .png()
    .toFile(file);
  const media = await stageMedia(context, { file, originalFilename: name });
  return { media, done: () => discardStaging(context, folder) };
}

export interface Seeded {
  archiveId: string;
  ids: Record<string, string>;
}

export async function seedArchive(context: ArchivistContext): Promise<Seeded> {
  const { archiveId } = createArchive(context, OWNER, { name: "Hangout History" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const ids: Record<string, string> = {};
  const version = (table: string, id: string) =>
    (
      context.stores
        .get(archiveId)!
        .db.prepare(`SELECT version FROM ${table} WHERE id = ?`)
        .get(id) as { version: number }
    ).version;

  const names = ["Sam", "Lee", "Alex", "Priya", "Mateo", "Kai"];
  const characters = names.map((knownName, i) => {
    const c = createCharacter(context, MEMBER, {
      archiveId,
      knownName,
      ...(i === 0
        ? { realName: "Samantha Reyes", birthDay: "2001-04-12", metInPerson: "yes" }
        : {}),
    });
    ids[knownName] = c.id;
    return { ...c, knownName };
  });
  const hangout = createServer(context, MEMBER, {
    archiveId,
    label: "The Hangout",
    discordId: "727573539904815224",
  });
  const owls = createServer(context, MEMBER, { archiveId, label: "Night Owls" });
  const general = createChannel(context, MEMBER, {
    archiveId,
    kind: "guild_channel",
    label: "general",
    serverId: hangout.id,
  });
  const memes = createChannel(context, MEMBER, {
    archiveId,
    kind: "guild_channel",
    label: "memes",
    serverId: hangout.id,
  });
  const trip = createChannel(context, MEMBER, {
    archiveId,
    kind: "group_chat",
    label: "Road Trip",
  });
  Object.assign(ids, {
    hangout: hangout.id,
    owls: owls.id,
    general: general.id,
    memes: memes.id,
    trip: trip.id,
  });
  updateArchiveSettings(context, OWNER, {
    archiveId,
    expectedVersion: 1,
    mainServerId: hangout.id,
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "server_name",
    parentId: hangout.id,
    expectedVersion: 1,
    name: "Hangout 2.0",
    date: "2020-03-14",
  });

  // Accounts with avatars, a rename, and main accounts, so pictures follow the timeline.
  for (const [i, character] of characters.slice(0, 4).entries()) {
    const account = createAccount(context, MEMBER, {
      archiveId,
      kind: "human",
      label: character.knownName.toLowerCase(),
      characterId: character.id,
      discordId: i === 0 ? "175928847299117063" : undefined,
    });
    ids[`${character.knownName}Account`] = account.id;
    for (const [n, day] of ["2019-08-01", "2020-05-10"].entries()) {
      if (n === 1 && i > 1) continue;
      const pic = await image(
        context,
        COLORS[(i * 2 + n) % COLORS.length]!,
        `avatar-${i}-${n}.png`,
        [64, 64],
      );
      addHistory(context, MEMBER, {
        archiveId,
        kind: "avatar",
        parentId: account.id,
        expectedVersion: version("accounts", account.id),
        media: pic.media,
        date: day,
      });
      pic.done();
    }
    addHistory(context, MEMBER, {
      archiveId,
      kind: "main_account",
      parentId: character.id,
      expectedVersion: version("characters", character.id),
      targetId: account.id,
      date: "2019-08-01",
    });
    addHistory(context, MEMBER, {
      archiveId,
      kind: "membership",
      parentId: account.id,
      expectedVersion: version("accounts", account.id),
      targetId: hangout.id,
      start: "2019-08-03",
    });
  }
  addHistory(context, MEMBER, {
    archiveId,
    kind: "account_name",
    parentId: ids.SamAccount!,
    expectedVersion: version("accounts", ids.SamAccount!),
    name: "samwise",
    date: "2020-04-02",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: ids.Sam!,
    expectedVersion: version("characters", ids.Sam!),
    name: "Sammy",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "introduction",
    parentId: ids.Lee!,
    expectedVersion: version("characters", ids.Lee!),
    targetId: ids.Sam!,
    date: "2019-08-02",
  });

  // Artifacts across two years, some estimated, one in a group chat, one undated.
  const places = [[general.id], [memes.id], [general.id], [trip.id], []];
  let n = 0;
  for (let month = 0; month < 22; month++) {
    for (let k = 0; k < 2; k++) {
      n += 1;
      const day = new Date(Date.UTC(2019, 7 + month, 3 + k * 11)).toISOString().slice(0, 10);
      const pic = await image(context, COLORS[n % COLORS.length]!, `photo-${n}.png`);
      const who = [characters[n % 6]!.id, characters[(n + 1) % 4]!.id];
      const artifact = createArtifact(context, MEMBER, {
        archiveId,
        description: `Moment ${n}: ${["meetup", "game night", "stream", "road trip", "meme"][n % 5]}`,
        media: pic.media,
        source: { provider: "discord_attachment", key: `5${String(n).padStart(17, "0")}` },
        exactDate: n % 4 === 0 ? undefined : day,
        estimatedDate: n % 4 === 0 ? { day, reason: "Decorations in the photo" } : null,
        links: { characters: [...new Set(who)], channels: places[n % 5]! },
      }).artifact;
      ids[`artifact${n}`] = artifact.id;
      pic.done();
    }
  }
  const undated = await image(context, "#80848e", "undated.png");
  ids.undated = createArtifact(context, MEMBER, {
    archiveId,
    description: "An old meme nobody can date",
    media: undated.media,
    source: { provider: "discord_attachment", key: "599999999999999999" },
    links: {},
  }).artifact.id;
  undated.done();

  ids.launch = createEvent(context, MEMBER, {
    archiveId,
    title: "The Hangout opens",
    description: "Sam made the server.",
    dateKind: "single",
    certainty: "exact",
    start: "2019-08-03",
    links: { servers: [hangout.id], characters: [ids.Sam!] },
  }).id;
  ids.summer = createEvent(context, MEMBER, {
    archiveId,
    title: "Summer Minecraft season",
    description: "A shared survival world.",
    dateKind: "duration",
    certainty: "exact",
    start: "2020-06-01",
    end: "2020-08-31",
    links: { characters: [ids.Sam!, ids.Lee!, ids.Alex!] },
  }).id;
  ids.exams = createEvent(context, MEMBER, {
    archiveId,
    title: "Exam month",
    description: "Everyone was busy.",
    dateKind: "occurrence_window",
    certainty: "estimated",
    start: "2020-11-15",
    end: "2020-12-15",
  }).id;
  ids.request = createRequest(context, MEMBER, {
    archiveId,
    description: "Photos from the first meetup",
    characters: [ids.Sam!, ids.Lee!],
    constraint: { kind: "before_event", eventId: ids.summer },
  }).id;
  updateEntity(context, MEMBER, {
    archiveId,
    kind: "server",
    id: owls.id,
    expectedVersion: 1,
    color: "#eb459e",
  });
  return { archiveId, ids };
}
