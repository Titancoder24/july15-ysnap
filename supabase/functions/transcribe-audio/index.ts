import { 
  handleCors, 
  verifyUser, 
  formatError, 
  formatResponse, 
  checkRateLimit, 
  logUsageEvent,
  getSecret
} from "../shared/index.ts";

const whisperLanguages = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'bn', name: 'Bengali' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'tr', name: 'Turkish' },
  { code: 'pl', name: 'Polish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'sw', name: 'Swahili' },
  { code: 'fa', name: 'Persian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'kn', name: 'Kannada' },
  { code: 'mr', name: 'Marathi' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'af', name: 'Afrikaans' },
  { code: 'hy', name: 'Armenian' },
  { code: 'as', name: 'Assamese' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'be', name: 'Belarusian' },
  { code: 'bs', name: 'Bosnian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'ceb', name: 'Cebuano' },
  { code: 'ny', name: 'Chichewa' },
  { code: 'hr', name: 'Croatian' },
  { code: 'et', name: 'Estonian' },
  { code: 'fil', name: 'Filipino' },
  { code: 'gl', name: 'Galician' },
  { code: 'ka', name: 'Georgian' },
  { code: 'ha', name: 'Hausa' },
  { code: 'is', name: 'Icelandic' },
  { code: 'ga', name: 'Irish' },
  { code: 'jv', name: 'Javanese' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'ky', name: 'Kyrgyz' },
  { code: 'lv', name: 'Latvian' },
  { code: 'ln', name: 'Lingala' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lb', name: 'Luxembourgish' },
  { code: 'mk', name: 'Macedonian' },
  { code: 'ne', name: 'Nepali' },
  { code: 'ps', name: 'Pashto' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sd', name: 'Sindhi' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'so', name: 'Somali' },
  { code: 'cy', name: 'Welsh' }
];

function normalizeLanguage(langStr: string | null): { code: string | null; name: string | null } {
  if (!langStr) return { code: null, name: null };
  const lower = langStr.toLowerCase().trim();
  
  const directMatch = whisperLanguages.find(l => l.code === lower);
  if (directMatch) return { code: directMatch.code, name: directMatch.name };

  const nameMatch = whisperLanguages.find(l => l.name.toLowerCase() === lower);
  if (nameMatch) return { code: nameMatch.code, name: nameMatch.name };

  const fuzzyMatch = whisperLanguages.find(l => 
    lower.includes(l.name.toLowerCase()) || l.name.toLowerCase().includes(lower)
  );
  if (fuzzyMatch) return { code: fuzzyMatch.code, name: fuzzyMatch.name };
  
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

