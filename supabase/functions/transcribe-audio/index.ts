import { 
  handleCors, 
  verifyUser, 
  formatError, 
  formatResponse, 
  checkRateLimit, 
  logUsageEvent,
  getSecret
} from "../shared/index.ts";

function normalizeLanguage(langStr: string | null): { code: string | null; name: string | null } {
  if (!langStr) return { code: null, name: null };
  const lower = langStr.toLowerCase().trim();
  
  if (lower === 'en' || lower === 'english') return { code: 'en', name: 'English' };
  if (lower === 'ta' || lower === 'tamil') return { code: 'ta', name: 'Tamil' };
  if (lower === 'es' || lower === 'spanish' || lower === 'español') return { code: 'es', name: 'Spanish' };
  if (lower === 'hi' || lower === 'hindi') return { code: 'hi', name: 'Hindi' };
  if (lower === 'fr' || lower === 'french') return { code: 'fr', name: 'French' };
  if (lower === 'de' || lower === 'german') return { code: 'de', name: 'German' };
  if (lower === 'zh' || lower === 'chinese' || lower === 'mandarin') return { code: 'zh', name: 'Chinese' };
  if (lower === 'ja' || lower === 'japanese') return { code: 'ja', name: 'Japanese' };
  if (lower === 'ko' || lower === 'korean') return { code: 'ko', name: 'Korean' };
  if (lower === 'it' || lower === 'italian') return { code: 'it', name: 'Italian' };
  if (lower === 'pt' || lower === 'portuguese') return { code: 'pt', name: 'Portuguese' };
  if (lower === 'ru' || lower === 'russian') return { code: 'ru', name: 'Russian' };
  
  if (lower.length === 2) {
    return { code: lower, name: langStr };
  }
  return { code: lower.slice(0, 2), name: langStr };
}

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const userId = await verifyUser(req);
    checkRateLimit(userId);

    const openRouterApiKey = await getSecret('OPENROUTER_API_KEY');
    if (!openRouterApiKey) {
      return formatError("OPENROUTER_API_KEY is not configured", 500);
    }

    const url = new URL(req.url);
    let languageHint = url.searchParams.get("language");

    const contentType = req.headers.get("content-type") ?? "";
    let fileBlob: Blob;
    let fileName = "audio.mp3";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        return formatError("Missing parameter: 'file' field is required in form-data");
      }
      fileBlob = file;
      fileName = file.name || "audio.mp3";
      
      const formLang = formData.get("language");
      if (formLang && typeof formLang === 'string') {
        languageHint = formLang;
      }
    } else if (contentType.startsWith("audio/")) {
      const arrayBuffer = await req.arrayBuffer();
      fileBlob = new Blob([arrayBuffer], { type: contentType });
    } else {
      return formatError("Invalid Content-Type. Must be multipart/form-data or audio/*");
    }

    const MAX_SIZE = 20 * 1024 * 1024;
    if (fileBlob.size > MAX_SIZE) {
      return formatError(`File size exceeds limit of 20MB. Received size: ${(fileBlob.size / (1024 * 1024)).toFixed(2)}MB`);
    }

    const outboundFormData = new FormData();
    outboundFormData.append("file", fileBlob, fileName);
    outboundFormData.append("model", "openai/whisper-large-v3-turbo");
    outboundFormData.append("response_format", "verbose_json");
    if (languageHint) {
      outboundFormData.append("language", languageHint);
    }

    console.log(`Transcribing audio using OpenRouter whisper-large-v3-turbo... Size: ${(fileBlob.size / 1024).toFixed(1)} KB`);
    const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterApiKey}`
      },
      body: outboundFormData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter STT API returned status ${response.status}: ${errorText}`);
    }

    const openRouterResult = await response.json();
    const text = openRouterResult.text || "";
    
    // Normalize language
    const rawLang = openRouterResult.language;
    const { code: detectedLanguage, name: detectedLanguageName } = normalizeLanguage(rawLang);
    
    const durationSeconds = typeof openRouterResult.duration === 'number' 
      ? openRouterResult.duration 
      : null;

    const languageConfidence = typeof openRouterResult.language_confidence === 'number'
      ? openRouterResult.language_confidence
      : null;

    const normalizedResult = {
      success: true,
      text,
      detectedLanguage,
      detectedLanguageName,
      languageConfidence,
      durationSeconds
    };

    // Log usage event
    await logUsageEvent(userId, 'transcription', fileBlob.size, 'bytes', {
      file_size: fileBlob.size,
      text_length: text.length,
      detected_language: detectedLanguage
    });

    return formatResponse(normalizedResult);
  } catch (err) {
    return formatError(err);
  }
});

