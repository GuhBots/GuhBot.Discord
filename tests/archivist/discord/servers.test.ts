import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Client } from "discordx";
import { onlyInServers, openServerStore } from "../../../src/lib/archivist-servers.js";
import { commandsByScope } from "../../../src/lib/command-sync.js";

const HANGOUT = "690900000000000001";
const SUPPORT = "727573539904815224";
const OTHER = "800000000000000002";
const OWNER = "450414958421868554";

function clock(start = Date.UTC(2026, 10, 24)) {
  let ms = start;
  return () => new Date((ms += 1000));
}

test("the starting servers are copied once, when the list is created", () => {
  const database = new Database(":memory:");
  const first = openServerStore(database, [HANGOUT, SUPPORT, HANGOUT], clock());
  assert.equal(first.created, true);
  assert.equal(first.copied, 2);
  assert.deepEqual(first.store.ids().sort(), [HANGOUT, SUPPORT].sort());
  assert.equal(first.store.list()[0]!.addedBy, null);

  // A server removed later stays removed, even while the setting still lists it.
  first.store.remove(SUPPORT);
  const second = openServerStore(database, [HANGOUT, SUPPORT, OTHER], clock());
  assert.equal(second.created, false);
  assert.equal(second.copied, 0);
  assert.deepEqual(second.store.ids(), [HANGOUT]);
});

test("servers are added and removed once, and listed oldest first", () => {
  const { store } = openServerStore(new Database(":memory:"), [], clock());
  assert.deepEqual(store.list(), []);
  assert.equal(store.add(SUPPORT, OWNER), true);
  assert.equal(store.add(SUPPORT, OWNER), false);
  assert.equal(store.add(HANGOUT, OWNER), true);
  assert.equal(store.has(SUPPORT), true);
  assert.equal(store.has(OTHER), false);
  assert.deepEqual(
    store.list().map((server) => [server.guildId, server.addedBy]),
    [
      [SUPPORT, OWNER],
      [HANGOUT, OWNER],
    ],
  );
  assert.equal(store.remove(SUPPORT), true);
  assert.equal(store.remove(SUPPORT), false);
  assert.deepEqual(store.ids(), [HANGOUT]);
});

test("the guard lets listed servers through and refuses other servers and DMs", async () => {
  const { store } = openServerStore(new Database(":memory:"), [HANGOUT]);
  const guard = onlyInServers(() => store);

  async function run(guildId: string | null) {
    const replies: unknown[] = [];
    let passed = false;
    const interaction = { guildId, reply: async (reply: unknown) => void replies.push(reply) };
    await guard(interaction as never, {} as never, async () => void (passed = true), {});
    return { passed, replies };
  }

  assert.deepEqual(await run(HANGOUT), { passed: true, replies: [] });
  for (const guildId of [OTHER, null]) {
    const { passed, replies } = await run(guildId);
    assert.equal(passed, false);
    assert.equal(replies.length, 1);
    assert.match((replies[0] as { content: string }).content, /not turned on in this server/);
  }
});

test("a command whose server list is empty is registered nowhere", async () => {
  let servers: string[] = [];
  const command = (name: string, guilds: unknown[]) => ({
    isBotAllowed: () => true,
    guilds,
    toJSON: () => ({ name }),
  });
  const client = {
    botId: "1",
    botResolvedGuilds: Promise.resolve([]),
    applicationCommands: [
      command("archive", [() => servers]),
      command("owner", [SUPPORT]),
      command("ping", []),
    ],
  } as unknown as Client;

  const names = (scopes: Map<string, { name: string }[]>) =>
    Object.fromEntries([...scopes].map(([scope, list]) => [scope, list.map((c) => c.name)]));

  assert.deepEqual(names(await commandsByScope(client)), {
    global: ["ping"],
    [SUPPORT]: ["owner"],
  });

  servers = [SUPPORT, HANGOUT];
  assert.deepEqual(names(await commandsByScope(client)), {
    global: ["ping"],
    [SUPPORT]: ["archive", "owner"],
    [HANGOUT]: ["archive"],
  });
});
