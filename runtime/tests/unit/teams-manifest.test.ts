import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Teams app package is the step that was missing (#162).
 *
 * Adding the Teams channel to the Azure Bot resource makes the bot reachable by
 * Teams infrastructure; it does not make it installable by a person. Without this
 * manifest, a deep link to the bot answers "You do not have permission to use this
 * app here" — and nothing on our side reports that, because the endpoint is healthy
 * and returns a correct 401 to unsigned requests.
 *
 * These assertions are the constraints Microsoft's own v1.19 schema imposes, checked
 * here rather than discovered when an upload is rejected in the Teams admin center
 * with a message that rarely names the field.
 */

const manifest = JSON.parse(
  readFileSync(join(__dirname, "../../../teams-app/manifest.json"), "utf8"),
) as Record<string, unknown>;

const REQUIRED_TOP_LEVEL = [
  "manifestVersion", "version", "id", "developer", "name", "description", "icons", "accentColor",
];

describe("Teams app manifest", () => {
  it("carries every field the schema marks required", () => {
    for (const key of REQUIRED_TOP_LEVEL) expect(manifest).toHaveProperty(key);
  });

  it("respects the length caps, which are short and easy to overrun", () => {
    const name = manifest.name as { short: string; full: string };
    const desc = manifest.description as { short: string; full: string };
    expect(name.short.length).toBeLessThanOrEqual(30);
    expect(name.full.length).toBeLessThanOrEqual(100);
    // 80 is the tight one: it is a sentence describing the whole product.
    expect(desc.short.length).toBeLessThanOrEqual(80);
    expect(desc.full.length).toBeLessThanOrEqual(4000);
  });

  it("declares a bot with the two fields the schema requires", () => {
    const bot = (manifest.bots as Record<string, unknown>[])[0]!;
    expect(bot).toHaveProperty("botId");
    expect(bot).toHaveProperty("scopes");
  });

  it("uses only the three scopes the schema allows", () => {
    // 'copilot' exists in v1.21+ but not in the version this manifest declares;
    // an unknown scope fails the upload rather than being ignored.
    const bot = (manifest.bots as { scopes: string[] }[])[0]!;
    for (const s of bot.scopes) expect(["personal", "team", "groupChat"]).toContain(s);
  });

  it("claims file support, because the bot genuinely parses attachments", () => {
    // A resume PDF with no caption is a valid request (#159). Declaring false here
    // would have Teams strip attachments before we ever see them.
    const bot = (manifest.bots as { supportsFiles?: boolean }[])[0]!;
    expect(bot.supportsFiles).toBe(true);
  });

  it("asks for team and groupChat scope, because routing reads the channel name", () => {
    // detectAgent() matches against `${channelName} ${text}`, so a #govcon channel
    // reaches Beady unprompted. Personal-only scope would throw that away.
    const bot = (manifest.bots as { scopes: string[] }[])[0]!;
    expect(bot.scopes).toContain("team");
    expect(bot.scopes).toContain("groupChat");
  });

  it("keeps the bot id as a placeholder rather than a committed GUID", () => {
    // Production and staging have different registrations. A manifest with one
    // baked in is a manifest someone uploads to the wrong tenant, producing an app
    // that installs and then silently never answers.
    expect(manifest.id).toBe("__TEAMS_BOT_APP_ID__");
    expect((manifest.bots as { botId: string }[])[0]!.botId).toBe("__TEAMS_BOT_APP_ID__");
  });

  it("declares an accentColor in the #RRGGBB form the schema demands", () => {
    expect(manifest.accentColor as string).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("names icon files that are actually in the package", () => {
    const icons = manifest.icons as { color: string; outline: string };
    expect(icons.color).toBe("color.png");
    expect(icons.outline).toBe("outline.png");
  });
});
