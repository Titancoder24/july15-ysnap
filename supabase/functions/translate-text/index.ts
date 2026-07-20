import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.0";
import { 
  handleCors, 
  verifyUser, 
  parseJsonBody, 
  formatError, 
  formatResponse, 
  checkRateLimit, 
  logUsageEvent,
  generateTextResult,
  safeParseAIJson,
  getSecret
} from "../shared/index.ts";

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const userId = await verifyUser(req);
    checkRateLimit(userId);

    const { source, target, text } = await parseJsonBody<{
      source?: string;
      target: string;
      text: string;
    }>(req);

    if (!text || !text.trim()) {
      return formatError("Missing parameter: text is required");
    }
    if (!target || !target.trim()) {
      return formatError("Missing parameter: target is required");
    }

    const openRouterApiKey = await getSecret("OPENROUTER_API_KEY");

    const systemInstruction = `You are an expert translator. Translate the text and return a JSON object with the following keys:
- "translated_text": (string) the translation of the source text to the target language "${target}"
- "detected_language": (string) the detected language of the source text (e.g. "en", "es", "fr", "zh", etc.)
- "transliteration": (string or null) the transliteration / pronunciation guide of the translated text (especially if target language uses non-Latin script, otherwise null)
- "alternatives": (array of strings) 2-3 alternative translation options (different tones or contexts)
- "context_notes": (string) contextual advice, grammatical tips, or usage details.

Your entire response must be a single, valid JSON object without markdown wrapping or backticks.`;

    const promptText = `Translate this text from "${source || 'auto-detect'}" to "${target}":\n\n${text}`;
    
    console.log("Calling OpenRouter completions with model google/gemini-3.5-flash...");
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ysnap.vercel.app",
        "X-Title": "YSnap Client App"
      },
      body: JSON.stringify({
        model: "google/gemini-3.5-flash",
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: promptText }
        ],
        response_format: { type: "json_object" }
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter translation request failed with status ${response.status}: ${await response.text()}`);
    }

    const resJson = await response.json();
    const responseText = resJson.choices?.[0]?.message?.content || "";
    
    // Parse the JSON output from AI using robust safeParseAIJson helper
    const parsedResult = safeParseAIJson<{
      translated_text: string;
      detected_language?: string;
      transliteration?: string | null;
      alternatives?: string[];
      context_notes?: string;
    }>(responseText, {
      translated_text: 'string',
      detected_language: 'string',
      transliteration: 'string',
      alternatives: 'array',
      context_notes: 'string'
    });

    if (!parsedResult.translated_text) {
      parsedResult.translated_text = responseText;
      parsedResult.context_notes = parsedResult.context_notes || "Failed to parse structured meta-information from AI.";
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    );

    const sourceLanguage = source?.trim() || parsedResult.detected_language || 'auto';
    const targetLanguage = target.trim();
    const { data: session, error: sessionError } = await supabase
      .from('translation_sessions')
      .insert({
        user_id: userId,
        session_type: 'text',
        source_language: sourceLanguage,
        target_language: targetLanguage,
        title: text.trim().slice(0, 80),
        status: 'completed',
        metadata: {
          translation_provider: 'google',
          translation_model: "google/gemini-3.5-flash",
        },
      })
      .select('id')
      .single();
    if (sessionError || !session) {
      throw new Error(`Failed to save translation session: ${sessionError?.message}`);
    }

    const { data: item, error: itemError } = await supabase
      .from('translation_items')
      .insert({
        session_id: session.id,
        user_id: userId,
        sequence_number: 1,
        source_text: text.trim(),
        translated_text: parsedResult.translated_text,
        transliteration: parsedResult.transliteration || null,
        detected_language: parsedResult.detected_language || sourceLanguage,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        alternatives: parsedResult.alternatives || [],
        context_notes: parsedResult.context_notes || null,
      })
      .select('id')
      .single();
    if (itemError || !item) {
      throw new Error(`Failed to save translated text: ${itemError?.message}`);
    }

    // Log usage: quantity is text length
    await logUsageEvent(userId, 'translation', text.length, 'characters', {
      source,
      target,
      text_length: text.length,
      provider: 'google',
      model: "google/gemini-3.5-flash"
    });

    return formatResponse({
      ...parsedResult,
      translation_model: "google/gemini-3.5-flash",
      session_id: session.id,
      translation_item_id: item.id,
    });
  } catch (err) {
    return formatError(err);
  }
});
