// Jira Cloud client for filing marketing-change requests.
//
// Used by the request_marketing_change MCP tool. Everything lives behind env
// config (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY). When
// any of those are missing the client does not throw: it returns a structured
// "not configured" result so local dev and the build work without credentials.
//
// No token or email is ever hardcoded here; config is read from the injected
// env (defaults to process.env).

export type MarketingIssueInput = {
  title: string;
  description: string;
  promoCode?: string;
  discountPercent?: number;
  startsAt?: string;
  endsAt?: string;
};

export type MarketingIssueResult = {
  configured: boolean;
  key?: string;
  url?: string;
  error?: string;
};

// Subset of env that the Jira client reads. Kept loose so callers can pass the
// validated Env, a Pick of it, or plain process.env.
export type JiraEnv = {
  JIRA_BASE_URL?: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
  JIRA_PROJECT_KEY?: string;
};

type JiraConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
};

function readJiraConfig(env: JiraEnv): JiraConfig | null {
  const baseUrl = env.JIRA_BASE_URL?.trim();
  const email = env.JIRA_EMAIL?.trim();
  const apiToken = env.JIRA_API_TOKEN?.trim();
  const projectKey = env.JIRA_PROJECT_KEY?.trim();
  if (!baseUrl || !email || !apiToken || !projectKey) {
    return null;
  }
  return {
    // Trim a trailing slash so URL construction is predictable.
    baseUrl: baseUrl.replace(/\/+$/, ""),
    email,
    apiToken,
    projectKey,
  };
}

// Minimal Atlassian Document Format (ADF) node types. Jira Cloud requires the
// issue description in ADF rather than plain text.
type AdfText = { type: "text"; text: string };
type AdfParagraph = { type: "paragraph"; content: AdfText[] };
export type AdfDoc = {
  type: "doc";
  version: 1;
  content: AdfParagraph[];
};

function paragraph(text: string): AdfParagraph {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

// Build a minimal ADF document from the description plus any promo details.
// The first paragraph is the free-text description; each supplied promo detail
// becomes its own paragraph so the ticket reads cleanly.
export function buildMarketingAdf(input: MarketingIssueInput): AdfDoc {
  const paragraphs: AdfParagraph[] = [paragraph(input.description)];

  if (input.promoCode) {
    paragraphs.push(paragraph(`Promo code: ${input.promoCode}`));
  }
  if (input.discountPercent !== undefined) {
    paragraphs.push(paragraph(`Discount: ${input.discountPercent} percent off`));
  }
  if (input.startsAt) {
    paragraphs.push(paragraph(`Starts at: ${input.startsAt}`));
  }
  if (input.endsAt) {
    paragraphs.push(paragraph(`Ends at: ${input.endsAt}`));
  }

  return { type: "doc", version: 1, content: paragraphs };
}

// Construct the Basic auth header value: base64(email + ":" + apiToken).
export function basicAuthHeader(email: string, apiToken: string): string {
  const encoded = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return `Basic ${encoded}`;
}

// File a marketing-change request as a Jira issue. Returns a structured result
// rather than throwing, so callers (the MCP tool) can surface a clear message
// whether Jira is configured, the issue was created, or the API failed.
export async function createMarketingIssue(
  input: MarketingIssueInput,
  env: JiraEnv = process.env as JiraEnv,
): Promise<MarketingIssueResult> {
  const config = readJiraConfig(env);
  if (!config) {
    return {
      configured: false,
      error:
        "Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, " +
        "JIRA_API_TOKEN, and JIRA_PROJECT_KEY to file marketing tickets.",
    };
  }

  const body = {
    fields: {
      project: { key: config.projectKey },
      summary: input.title,
      description: buildMarketingAdf(input),
      issuetype: { name: "Task" },
    },
  };

  try {
    const response = await fetch(`${config.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(config.email, config.apiToken),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        configured: true,
        error: `Jira returned ${response.status}: ${text || response.statusText}`,
      };
    }

    let key: string | undefined;
    try {
      const parsed = JSON.parse(text) as { key?: string };
      key = parsed.key;
    } catch {
      key = undefined;
    }

    if (!key) {
      return {
        configured: true,
        error: "Jira response did not include an issue key.",
      };
    }

    return {
      configured: true,
      key,
      url: `${config.baseUrl}/browse/${key}`,
    };
  } catch (err) {
    return {
      configured: true,
      error: `Jira request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
