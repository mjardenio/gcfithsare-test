/// <reference path="./deno.d.ts" />
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type ModerationResult = {
  approved: boolean;
  reason: string;
  flags: string[];
  source: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Per-request timeout for AI provider calls — prevents the function hanging forever. */
const AI_FETCH_TIMEOUT_MS = 10_000;

const moderationPrompt = (title: string, body: string, hashtags: string[]) => `
You are a content moderator for GC FitShare, a wellness platform for Gordon College students.

Analyze this post and respond ONLY with valid JSON:
{
  "approved": true or false,
  "reason": "short reason if rejected, empty string if approved",
  "flags": ["list", "of", "issues"] or []
}

Reject if the post contains:
- Spam or advertising
- Hate speech, slurs, or harassment
- Harmful or dangerous health misinformation
- Phishing links or scam content
- Content unrelated to wellness (diet, exercise, time management)
- Explicit or inappropriate content

Post to analyze:
Title: ${title}
Body: ${body || "(no body)"}
Hashtags: ${hashtags.length ? hashtags.join(" ") : "(none)"}
`;

/**
 * Comments: ONLY vulgar / profanity / explicit sexual language / insulting epithets.
 * Do not apply post-level rules (spam, wellness fit, harassment tone without slurs, links, etc.).
 */
const commentModerationPrompt = (body: string) => `
You filter COMMENT text for GC FitShare. Respond ONLY with valid JSON:
{
  "approved": true or false,
  "reason": "short reason if rejected, empty string if approved",
  "flags": ["list", "of", "issues"] or []
}

Reject (approved=false) if the comment contains ANY of:
- Profanity / vulgar / obscene words in English OR Filipino/Tagalog (examples: fuck, shit, bitch, asshole, gago, putangina, tangina, ulol, tarantado, lecheng, punyeta)
- Insults used as name-calling (examples: idiot, stupid, moron, dumbass, bobo, tanga)
- Sexually explicit / graphic sexual wording
- Common abusive slurs or epithets

Always approve clean disagreement, criticism, emoji, typos, and non-obscene slang.

Comment text:
${body || "(empty)"}
`;

/** Fast local blocklist so obvious insults still get blocked when AI is down. */
const PROFANITY_PATTERNS: RegExp[] = [
  /\b(fuck(?:ing|er|ed)?|shit(?:ty)?|bitch(?:es)?|asshole|bastard|dickhead|motherfucker|cunt)\b/i,
  /\b(idiot|stupid|moron|dumbass|retard(?:ed)?)\b/i,
  /\b(gago|gaga|putangina|tangina|puta|ulol|tarantado|leche(?:ng)?|punyeta|bobo|tanga|inutil)\b/i,
];

function findProfanityHit(text: string): string | null {
  const normalized = String(text || "").normalize("NFKC");
  for (const pattern of PROFANITY_PATTERNS) {
    const match = normalized.match(pattern);
    if (match?.[1] || match?.[0]) return (match[1] || match[0]).toLowerCase();
  }
  return null;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseAIResponse(rawText: string, source: string): ModerationResult {
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  if (!cleaned) throw new Error(`${source} returned empty response`);
  const parsed = JSON.parse(cleaned);
  return {
    approved: parsed.approved === true,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
    source,
  };
}

async function tryGemini(prompt: string): Promise<ModerationResult> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  // Prefer current Flash models; GEMINI_MODEL secret overrides the first choice.
  const preferred = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";
  const models = Array.from(new Set([preferred, "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash"]));
  const errors: string[] = [];

  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${endpoint}?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(AI_FETCH_TIMEOUT_MS),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 200,
              responseMimeType: "application/json",
            },
          }),
        });

        if (res.status === 503 || res.status === 429) {
          const errBody = await res.text().catch(() => "");
          errors.push(`${model} HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 100)}` : ""}`);
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          errors.push(`${model} HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 120)}` : ""}`);
          break; // try next model
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        return parseAIResponse(text, "Gemini");
      } catch (err) {
        errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  }

  throw new Error(errors.join(" | ") || "Gemini unavailable");
}

async function tryMistral(prompt: string): Promise<ModerationResult> {
  const apiKey = Deno.env.get("MISTRAL_API_KEY");
  if (!apiKey) throw new Error("MISTRAL_API_KEY missing");

  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(AI_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: Deno.env.get("MISTRAL_MODEL") || "mistral-small-latest",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 200,
    }),
  });

  if (!res.ok) throw new Error(`Mistral HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return parseAIResponse(text, "Mistral");
}

async function tryOpenAI(prompt: string): Promise<ModerationResult> {
  // Support both OPENAI_API_KEY and OPEN_AI_API_KEY secret names.
  const apiKey = Deno.env.get("OPENAI_API_KEY") || Deno.env.get("OPEN_AI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(AI_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 200,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return parseAIResponse(text, "OpenAI");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const { title = "", body = "", hashtags = [], contentType = "post" } = await req.json();
    const safeHashtags = Array.isArray(hashtags) ? hashtags : [];
    const isComment = String(contentType).toLowerCase() === "comment";
    const combinedText = isComment ? String(body) : `${title}\n${body}`;

    const hit = findProfanityHit(combinedText);
    if (hit) {
      return jsonResponse(
        {
          approved: false,
          reason: "Please keep language respectful — remove insults or vulgar words.",
          flags: ["profanity", "local_blocklist"],
          source: "local-blocklist",
        },
        200,
      );
    }

    const prompt = isComment
      ? commentModerationPrompt(String(body))
      : moderationPrompt(String(title), String(body), safeHashtags.map(String));

    const attempts: Array<{ name: string; run: () => Promise<ModerationResult> }> = [
      { name: "Gemini", run: () => tryGemini(prompt) },
      { name: "OpenAI", run: () => tryOpenAI(prompt) },
      { name: "Mistral", run: () => tryMistral(prompt) },
    ];

    const providerErrors: string[] = [];
    for (const attempt of attempts) {
      try {
        const result = await attempt.run();
        return jsonResponse(result, 200);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error || "unknown");
        providerErrors.push(`${attempt.name}: ${detail}`);
        console.error(`moderate-content ${attempt.name} failed:`, detail);
      }
    }

    // No soft-fail: if every AI provider fails, block until moderation is available again.
    return jsonResponse(
      {
        approved: false,
        reason: "AI moderation is currently unavailable. Please try again later.",
        flags: ["ai_unavailable"],
        source: "fallback",
        debug: providerErrors.join(" | ").slice(0, 500),
      },
      200,
    );
  } catch (err) {
    return jsonResponse(
      {
        approved: false,
        reason: "Moderation request failed.",
        flags: ["moderation_request_error"],
        source: "edge-function-error",
        error: err instanceof Error ? err.message : "Unknown error",
      },
      400,
    );
  }
});
