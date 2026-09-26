// AI suggestions for a commit message or a pull request, from the sign-in
// Worker's /describe route, which holds the Groq key and checks the sign-in.
// The caller sends what describe.js's forAi() produces: the change lines of
// published pages, and for private files (the Record, blog sources) a count.

export class SuggestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SuggestError";
    this.code = code;
  }
}

const MESSAGES = {
  ai_not_configured: "AI suggestions aren't set up: the Worker has no Groq key.",
  rate_limited: "Groq's free allowance is used up for now. Try again in a minute.",
  not_allowed: "Only the site's owner can ask for suggestions.",
  github_unavailable: "GitHub didn't confirm your sign-in. Try again in a moment.",
  ai_unavailable: "Groq didn't answer. Try again in a moment.",
  ai_unusable: "Groq's answer couldn't be used. Try again.",
  too_large: "Too many changes to describe at once.",
  invalid_request: "The editor sent a request the Worker didn't accept.",
};

// suggest(kind, changes) → { title, body }; kind is "commit" or "pr".
export function createSuggester({ workerUrl, fetch, getAccessToken }) {
  return async function suggest(kind, changes) {
    const accessToken = await getAccessToken();
    let response;
    try {
      response = await fetch(`${workerUrl}/describe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken, kind, changes }),
      });
    } catch {
      throw new SuggestError("network", "Couldn't reach the editor's sign-in service. Check the connection.");
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data || typeof data.title !== "string") {
      const code = data && typeof data.error === "string" ? data.error : `http_${response.status}`;
      const wait = code === "rate_limited" && data.retry_after ? ` (Groq asks for ${data.retry_after} s)` : "";
      throw new SuggestError(code, `${MESSAGES[code] || `The suggestion failed (${code}).`}${wait}`);
    }
    return { title: data.title, body: typeof data.body === "string" ? data.body : "" };
  };
}
