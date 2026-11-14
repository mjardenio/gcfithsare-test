## Deploy `moderate-content` edge function

1. Login and link your project:

```bash
supabase login
supabase link --project-ref sjhpalnvneposzilyfux
```

2. Set secrets (never store these in frontend code):

```bash
supabase secrets set GEMINI_API_KEY=your_key_here
supabase secrets set MISTRAL_API_KEY=your_key_here
supabase secrets set OPENAI_API_KEY=your_key_here
supabase secrets set GEMINI_MODEL=gemini-3.8-flash
supabase secrets set MISTRAL_MODEL=mistral-small-latest
supabase secrets set OPENAI_MODEL=gpt-4o-mini
```

Note: Gemini model IDs change over time. If moderation returns HTTP 404, update `GEMINI_MODEL` (and the default in `index.ts`) to the model name Google recommends in the error message.

3. Deploy function:

```bash
supabase functions deploy moderate-content
```

4. Test from app by creating a post in Main Feed.
