/**
 * GC FITSHARE — Content moderation client
 *
 * Primary path: direct Gemini API call using AI_CONFIG.gemini.key
 * (the key already ships client-side in 0_AI_Config.js).
 * Fallback path: Supabase Edge Function `moderate-content`.
 *
 * DEPENDS ON: AI_CONFIG from 0_AI_Config.js, getSupabaseClient() from 0_Utilities.js
 */

const GEMINI_MOD_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash'];
const GEMINI_MOD_TIMEOUT_MS = 15000;
const EDGE_MOD_TIMEOUT_MS = 20000;

const MOD_POST_PROMPT = (title, body, hashtags) => `
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

const MOD_COMMENT_PROMPT = (body) => `
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

const MOD_PROFANITY_PATTERNS = [
    /\b(fuck(?:ing|er|ed)?|shit(?:ty)?|bitch(?:es)?|asshole|bastard|dickhead|motherfucker|cunt)\b/i,
    /\b(idiot|stupid|moron|dumbass|retard(?:ed)?)\b/i,
    /\b(gago|gaga|putangina|tangina|puta|ulol|tarantado|leche(?:ng)?|punyeta|bobo|tanga|inutil)\b/i,
];

function findLocalProfanityHit(text) {
    const normalized = String(text || '').normalize('NFKC');
    for (const pattern of MOD_PROFANITY_PATTERNS) {
        const match = normalized.match(pattern);
        if (match?.[1] || match?.[0]) return (match[1] || match[0]).toLowerCase();
    }
    return null;
}

function parseModerationJson(rawText, source) {
    const cleaned = String(rawText || '').replace(/```json|```/g, '').trim();
    if (!cleaned) throw new Error(`${source} returned empty response`);
    const parsed = JSON.parse(cleaned);
    return {
        approved: parsed.approved === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        flags: Array.isArray(parsed.flags) ? parsed.flags : [],
        source
    };
}

/** Direct Gemini moderation — fast path, no edge function needed. */
async function callGeminiModerationDirect({ title, body, hashtags, contentType }) {
    const apiKey = (typeof AI_CONFIG !== 'undefined' && AI_CONFIG?.gemini?.key) || '';
    if (!apiKey) return null;

    const isComment = contentType === 'comment';
    const combinedText = isComment ? String(body || '') : `${title || ''}\n${body || ''}`;

    const hit = findLocalProfanityHit(combinedText);
    if (hit) {
        return {
            approved: false,
            reason: 'Please keep language respectful — remove insults or vulgar words.',
            flags: ['profanity', 'local_blocklist'],
            source: 'local-blocklist'
        };
    }

    const prompt = isComment
        ? MOD_COMMENT_PROMPT(String(body || ''))
        : MOD_POST_PROMPT(String(title || ''), String(body || ''), hashtags);

    const errors = [];
    for (const model of GEMINI_MOD_MODELS) {
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: AbortSignal.timeout(GEMINI_MOD_TIMEOUT_MS),
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            temperature: 0.1,
                            maxOutputTokens: 200,
                            responseMimeType: 'application/json'
                        }
                    })
                }
            );

            if (!res.ok) {
                errors.push(`${model} HTTP ${res.status}`);
                continue;
            }

            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
            return parseModerationJson(text, `gemini-direct:${model}`);
        } catch (err) {
            errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    throw new Error(errors.join(' | ') || 'Gemini unavailable');
}

/** Edge function fallback — used if direct Gemini fails. */
async function callModerationEdgeFunction(payload, accessToken) {
    const supabase = getSupabaseClient();
    if (!supabase) {
        throw new Error('Supabase client unavailable');
    }

    const { data, error } = await Promise.race([
        supabase.functions.invoke('moderate-content', {
            body: payload,
            headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
        }),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Moderation request timed out')), EDGE_MOD_TIMEOUT_MS)
        )
    ]);

    if (error) {
        throw new Error(error.message || 'Edge function invocation failed');
    }

    if (!data || typeof data.approved !== 'boolean') {
        throw new Error('Invalid moderation response');
    }

    return {
        approved: data.approved === true,
        reason: data.reason || '',
        flags: Array.isArray(data.flags) ? data.flags : [],
        source: data.source || 'edge-function',
        debug: typeof data.debug === 'string' ? data.debug : undefined
    };
}

async function analyzeContentWithGemini(title, body, hashtags, options = {}) {
    try {
        const contentType = options.contentType === 'comment' ? 'comment' : 'post';
        const safeHashtags = Array.isArray(hashtags) ? hashtags : [];
        const payload = {
            title: title || '',
            body: body || '',
            hashtags: safeHashtags,
            contentType
        };

        // 1) Fast path: direct Gemini (works even if edge function is down)
        try {
            const direct = await callGeminiModerationDirect(payload);
            if (direct) return direct;
        } catch (directErr) {
            console.warn('Direct Gemini moderation failed, trying edge function:', directErr);
        }

        // 2) Fallback: Supabase edge function
        let accessToken = '';
        try {
            const supabase = getSupabaseClient();
            const { data: sessionData } = await supabase.auth.getSession();
            accessToken = sessionData?.session?.access_token || '';
        } catch (_) { /* no session — invoke without auth header */ }

        return await callModerationEdgeFunction(payload, accessToken);
    } catch (err) {
        console.error('Secure moderation error:', err);
        const detail = err instanceof Error ? err.message : String(err || '');
        return {
            approved: false,
            reason: detail ? `AI moderation is currently unavailable. (${detail})` : 'AI moderation is currently unavailable. Please try again later.',
            flags: ['ai_unavailable', 'invoke_error'],
            source: 'edge-function-fallback',
            debug: detail
        };
    }
}
