// ─── AI API Keys ─────────────────────────────────────────────────────────────
// Replace these with your actual keys
// WARNING: In production, move these to a backend/edge function
const AI_CONFIG = {
    gemini: {
        key:      'AIzaSyDOFtd6NVpxzR9JjdfzoMq7k1mWpnzTF-A',
        model:    'gemini-3.5-flash-lite',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'
    },
    mistral: {
        key:      'QQJaie5IkGPe802MqZyO9bF5DGnSFHXu',
        model:    'codestral-latest', // Best for your VS Code project
        endpoint: 'https://api.mistral.ai/v1/chat/completions'
    },
    openai: {
        key:      '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',
        model:    'gpt-4o-mini',
        endpoint: 'https://api.openai.com/v1/chat/completions'
    }
};
