import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.0";

// CORS configuration
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
};

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}

// Parse Body
export async function parseJsonBody<T>(req: Request): Promise<T> {
  try {
    return await req.json() as T;
  } catch (err) {
    throw new Error('Malformed JSON body: ' + err.message);
  }
}

// User Verification (JWT validation)
export async function verifyUser(req: Request): Promise<string> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    throw new Error('Missing Authorization header');
  }
  const token = authHeader.replace('Bearer ', '');
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false }
  });
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) {
    throw new Error('Invalid JWT or unauthorized: ' + (error?.message ?? 'User not found'));
  }
  return user.id;
}

// Error & Response Formatters
export function formatError(error: any, status = 400): Response {
  console.error("API Error:", error);
  const message = error instanceof Error ? error.message : String(error);
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    }
  );
}

export function formatResponse(data: any, status = 200): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    }
  );
}

// Rate Limiter (In-Memory per Isolate)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(userId: string, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const state = rateLimitMap.get(userId);
  if (!state || now > state.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (state.count >= limit) {
    throw new Error('Rate limit exceeded. Please try again later.');
  }
  state.count++;
  return true;
}

// Usage Logger
export async function logUsageEvent(
  userId: string,
  eventType: 'transcription' | 'tts' | 'image_analysis' | 'translation' | 'summary' | 'voice_clone' | 'voice_change',
  quantity: number,
  unit: string,
  metadata: Record<string, any> = {}
) {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceRoleKey) {
      console.warn("Supabase credentials missing, cannot log usage event");
      return;
    }
    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });
    const { error } = await client.from('usage_events').insert({
      user_id: userId,
      event_type: eventType,
      quantity,
      unit,
      metadata
    });
    if (error) {
      console.error("Failed to insert usage event:", error);
    }
  } catch (err) {
    console.error("Error logging usage event:", err);
  }
}

// Gemini 3.5 Flash is always attempted first. Translation is latency-sensitive,
// so a stable Flash-Lite model keeps the app usable during temporary 429/5xx
// capacity events from the primary model.
export const GEMINI_MODEL = "gemini-3.5-flash";
export const GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";

export type GeneratedTextResult = {
  text: string;
  model: string;
};

const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);

function extractGeminiText(data: any, model: string): string {
  const text = data.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || "")
    .join("")
    .trim();
  if (text) return text;

  const blockReason = data.promptFeedback?.blockReason;
  throw new Error(
    blockReason
      ? `Gemini ${model} blocked the request: ${blockReason}`
      : `Gemini ${model} returned an empty response`,
  );
}

async function requestGeminiModel(
  model: string,
  geminiApiKey: string,
  prompt: string,
  systemInstruction?: string,
  jsonMode = false,
): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: jsonMode ? { responseMimeType: "application/json" } : undefined,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      }),
    },
  );

  const responseBody = await response.text();
  if (!response.ok) {
    let providerMessage = responseBody;
    try {
      providerMessage = JSON.parse(responseBody)?.error?.message || responseBody;
    } catch {
      // Preserve the provider's plain-text response.
    }
    const error = new Error(`Gemini ${model} returned status ${response.status}: ${providerMessage}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  return extractGeminiText(JSON.parse(responseBody), model);
}

async function requestGeminiMultimodalModel(
  model: string,
  geminiApiKey: string,
  imageBytes: Uint8Array,
  mimeType: string,
  prompt: string,
  systemInstruction?: string,
  jsonMode = false,
): Promise<string> {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < imageBytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...imageBytes.subarray(offset, offset + chunkSize));
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: btoa(binary) } },
          ],
        }],
        generationConfig: jsonMode ? { responseMimeType: "application/json" } : undefined,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      }),
    },
  );

  const responseBody = await response.text();
  if (!response.ok) {
    let providerMessage = responseBody;
    try {
      providerMessage = JSON.parse(responseBody)?.error?.message || responseBody;
    } catch {
      // Preserve the provider's plain-text response.
    }
    const error = new Error(`Gemini ${model} vision request returned status ${response.status}: ${providerMessage}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  return extractGeminiText(JSON.parse(responseBody), model);
}

// Get Secret with Database Vault Fallback
const secretCache = new Map<string, string>();

export async function getSecret(name: string): Promise<string> {
  const envVal = Deno.env.get(name);
  if (envVal) return envVal;

  const cached = secretCache.get(name);
  if (cached) return cached;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }
    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });
    const { data, error } = await client.rpc('get_decrypted_secret', { secret_name: name });
    if (error) {
      throw new Error(`RPC error: ${error.message}`);
    }
    if (data) {
      secretCache.set(name, data as string);
      return data as string;
    }
  } catch (err) {
    console.error(`Failed to get secret '${name}' from vault fallback:`, err);
  }

  throw new Error(`${name} is not configured in Supabase environment or vault`);
}

export async function generateTextResult(
  prompt: string,
  systemInstruction?: string,
  jsonMode = false,
): Promise<GeneratedTextResult> {
  const geminiApiKey = await getSecret('GEMINI_API_KEY');

  let primaryError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      console.log(`Calling Gemini model ${GEMINI_MODEL} (attempt ${attempt + 1})...`);
      return {
        text: await requestGeminiModel(
          GEMINI_MODEL,
          geminiApiKey,
          prompt,
          systemInstruction,
          jsonMode,
        ),
        model: GEMINI_MODEL,
      };
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error(String(error));
      const status = (primaryError as Error & { status?: number }).status;
      if (!status || !RETRYABLE_GEMINI_STATUSES.has(status)) throw primaryError;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  console.warn(`${GEMINI_MODEL} is temporarily unavailable; using ${GEMINI_FALLBACK_MODEL}.`, primaryError);
  return {
    text: await requestGeminiModel(
      GEMINI_FALLBACK_MODEL,
      geminiApiKey,
      prompt,
      systemInstruction,
      jsonMode,
    ),
    model: GEMINI_FALLBACK_MODEL,
  };
}

export async function generateText(
  prompt: string,
  systemInstruction?: string,
  jsonMode = false
): Promise<string> {
  return (await generateTextResult(prompt, systemInstruction, jsonMode)).text;
}

export async function generateMultimodalResult(
  imageBytes: Uint8Array,
  mimeType: string,
  prompt: string,
  systemInstruction?: string,
  jsonMode = false,
): Promise<GeneratedTextResult> {
  const geminiApiKey = await getSecret('GEMINI_API_KEY');

  let primaryError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return {
        text: await requestGeminiMultimodalModel(
          GEMINI_MODEL,
          geminiApiKey,
          imageBytes,
          mimeType,
          prompt,
          systemInstruction,
          jsonMode,
        ),
        model: GEMINI_MODEL,
      };
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error(String(error));
      const status = (primaryError as Error & { status?: number }).status;
      if (!status || !RETRYABLE_GEMINI_STATUSES.has(status)) throw primaryError;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  console.warn(`${GEMINI_MODEL} vision is temporarily unavailable; using ${GEMINI_FALLBACK_MODEL}.`, primaryError);
  return {
    text: await requestGeminiMultimodalModel(
      GEMINI_FALLBACK_MODEL,
      geminiApiKey,
      imageBytes,
      mimeType,
      prompt,
      systemInstruction,
      jsonMode,
    ),
    model: GEMINI_FALLBACK_MODEL,
  };
}

/**
 * Safe JSON parser for AI responses.
 * Attempts to parse as JSON, and falls back to regex-based extraction if parsing fails.
 */
export function safeParseAIJson<T extends Record<string, any>>(
  text: string,
  fieldTypes: Record<keyof T & string, 'string' | 'array' | 'any'>
): T {
  let cleanJson = text.trim();
  const firstBrace = cleanJson.indexOf('{');
  const lastBrace = cleanJson.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleanJson) as T;
  } catch (err) {
    console.error("Failed standard JSON parse, using regex fallback:", err.message);
    const result = {} as any;

    const extractRegexValue = (key: string): any => {
      const regex = new RegExp(`"${key}"\\s*:\\s*(?:"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|([^,\\s\\}\\]]+))`);
      const match = text.match(regex);
      if (match) {
        if (match[1] !== undefined) {
          return match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
        }
        const val = match[2].trim();
        if (val === 'null') return null;
        if (val === 'true') return true;
        if (val === 'false') return false;
        if (!isNaN(Number(val))) return Number(val);
        return val;
      }
      return null;
    };

    const extractRegexArray = (key: string): string[] => {
      const regex = new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`);
      const match = text.match(regex);
      if (match) {
        const arrayContent = match[1];
        const strRegex = /"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"/g;
        const results: string[] = [];
        let m;
        while ((m = strRegex.exec(arrayContent)) !== null) {
          results.push(m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'));
        }
        return results;
      }
      return [];
    };

    for (const [key, type] of Object.entries(fieldTypes)) {
      if (type === 'array') {
        result[key] = extractRegexArray(key);
      } else {
        result[key] = extractRegexValue(key);
      }
    }

    return result as T;
  }
}

