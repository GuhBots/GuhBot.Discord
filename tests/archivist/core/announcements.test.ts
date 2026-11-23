import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimAnnouncement,
  deliveryState,
  finishAnnouncement,
  getAnnouncementChannel,
  removeAnnouncementChannel,
  setAnnouncementChannel,
  settleInterruptedAnnouncements,
} from "../../../src/archivist/announcements.js";
import { createArchive, unregisterArchive } from "../../../src/archivist/archives.js";
import { ArchivistError } from "../../../src/archivist/errors.js";
import { addMember } from "../../../src/archivist/members.js";
import { makeArchivist, MEMBER, OTHER, OWNER } from "../helpers/context.js";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";

test("any member sets one announcement channel per archive, and outsiders cannot", (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Logs" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });

  setAnnouncementChannel(context, MEMBER, { archiveId, guildId: GUILD, channelId: CHANNEL });
  setAnnouncementChannel(context, MEMBER, {
    archiveId,
    guildId: GUILD,
    channelId: "333333333333333333",
  });
  assert.deepEqual(getAnnouncementChannel(context, archiveId), {
    guildId: GUILD,
    channelId: "333333333333333333",
  });
  assert.throws(
    () => setAnnouncementChannel(context, OTHER, { archiveId, guildId: GUILD, channelId: CHANNEL }),
    (error) => error instanceof ArchivistError && error.code === "archive_not_found",
  );
  assert.deepEqual(removeAnnouncementChannel(context, MEMBER, { archiveId }), { removed: true });
  assert.equal(getAnnouncementChannel(context, archiveId), null);
});

test("an artifact is announced at most once, and only definite failures can be retried", (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Logs" });
  const post = { archiveId, artifactId: "a1", guildId: GUILD, channelId: CHANNEL };

  assert.equal(claimAnnouncement(context, post), true);
  assert.equal(claimAnnouncement(context, post), false);
  finishAnnouncement(context, {
    archiveId,
    artifactId: "a1",
    state: "failed",
    errorCode: "missing access",
  });
  assert.equal(claimAnnouncement(context, post), true);
  finishAnnouncement(context, {
    archiveId,
    artifactId: "a1",
    state: "sent",
    messageId: "444444444444444444",
  });
  assert.equal(claimAnnouncement(context, post), false);

  const unknown = { ...post, artifactId: "a2" };
  claimAnnouncement(context, unknown);
  finishAnnouncement(context, { archiveId, artifactId: "a2", state: "indeterminate" });
  assert.equal(claimAnnouncement(context, unknown), false);
});

test("posts interrupted by a restart are never resent", (t) => {
  const archivist = makeArchivist(t);
  const { archiveId } = createArchive(archivist.context, OWNER, { name: "Logs" });
  claimAnnouncement(archivist.context, {
    archiveId,
    artifactId: "a1",
    guildId: GUILD,
    channelId: CHANNEL,
  });

  const context = archivist.restart();
  assert.equal(settleInterruptedAnnouncements(context), 1);
  assert.equal(deliveryState(context, archiveId, "a1"), "indeterminate");
  assert.equal(
    claimAnnouncement(context, { archiveId, artifactId: "a1", guildId: GUILD, channelId: CHANNEL }),
    false,
  );
});

test("unregistering an archive removes its announcement setting", (t) => {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Logs" });
  setAnnouncementChannel(context, OWNER, { archiveId, guildId: GUILD, channelId: CHANNEL });
  unregisterArchive(context, OWNER, { archiveId });
  assert.equal(getAnnouncementChannel(context, archiveId), null);
});
