// Jira client tests. fetch is mocked so no network call is made. We assert the
// not-configured path, the ADF body shape, and the Basic auth header
// construction.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basicAuthHeader,
  buildMarketingAdf,
  createMarketingIssue,
  type JiraEnv,
} from "../src/lib/jira.js";

const fullEnv: JiraEnv = {
  JIRA_BASE_URL: "https://flylo.atlassian.net",
  JIRA_EMAIL: "pm@flylo.example",
  JIRA_API_TOKEN: "test-token",
  JIRA_PROJECT_KEY: "MKT",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("basicAuthHeader", () => {
  it("base64-encodes email:token", () => {
    const expected = `Basic ${Buffer.from("a@b.com:tok").toString("base64")}`;
    expect(basicAuthHeader("a@b.com", "tok")).toBe(expected);
  });
});

describe("buildMarketingAdf", () => {
  it("produces a doc with the description as the first paragraph", () => {
    const doc = buildMarketingAdf({
      title: "Flash sale",
      description: "Weekend flash-sale banner.",
    });
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Weekend flash-sale banner." }],
    });
  });

  it("adds paragraphs for supplied promo details", () => {
    const doc = buildMarketingAdf({
      title: "Flash sale",
      description: "Weekend flash-sale banner.",
      promoCode: "FLASH20",
      discountPercent: 20,
      startsAt: "2026-07-11",
      endsAt: "2026-07-13",
    });
    const texts = doc.content.flatMap((p) => p.content.map((t) => t.text));
    expect(texts).toContain("Promo code: FLASH20");
    expect(texts).toContain("Discount: 20 percent off");
    expect(texts).toContain("Starts at: 2026-07-11");
    expect(texts).toContain("Ends at: 2026-07-13");
  });
});

describe("createMarketingIssue", () => {
  it("returns a not-configured result and does not call fetch when env is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await createMarketingIssue(
      { title: "Flash sale", description: "Banner + code." },
      {},
    );
    expect(result.configured).toBe(false);
    expect(result.error).toMatch(/not configured/i);
    expect(result.key).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts an ADF issue with Basic auth and returns the key + browse URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "1000", key: "MKT-42" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await createMarketingIssue(
      {
        title: "Flash sale banner + FLASH20",
        description: "Add a flash-sale banner and a 20 percent off code.",
        promoCode: "FLASH20",
        discountPercent: 20,
      },
      fullEnv,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://flylo.atlassian.net/rest/api/3/issue");
    expect(init?.method).toBe("POST");

    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      basicAuthHeader("pm@flylo.example", "test-token"),
    );
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(init?.body)) as {
      fields: {
        project: { key: string };
        summary: string;
        issuetype: { name: string };
        description: { type: string; version: number };
      };
    };
    expect(body.fields.project.key).toBe("MKT");
    expect(body.fields.summary).toBe("Flash sale banner + FLASH20");
    expect(body.fields.issuetype.name).toBe("Task");
    expect(body.fields.description.type).toBe("doc");
    expect(body.fields.description.version).toBe(1);

    expect(result).toEqual({
      configured: true,
      key: "MKT-42",
      url: "https://flylo.atlassian.net/browse/MKT-42",
    });
  });

  it("trims a trailing slash from the base URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ key: "MKT-7" }), { status: 201 }),
    );
    const result = await createMarketingIssue(
      { title: "T", description: "D" },
      { ...fullEnv, JIRA_BASE_URL: "https://flylo.atlassian.net/" },
    );
    expect(result.url).toBe("https://flylo.atlassian.net/browse/MKT-7");
  });

  it("returns a configured error result when Jira responds non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );
    const result = await createMarketingIssue(
      { title: "T", description: "D" },
      fullEnv,
    );
    expect(result.configured).toBe(true);
    expect(result.key).toBeUndefined();
    expect(result.error).toMatch(/400/);
  });
});
