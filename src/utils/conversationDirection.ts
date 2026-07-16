export interface ResolveDirectionParams {
  detectedLanguage: string | null;
  firstLanguage: string;
  secondLanguage: string;
  previousDetectedLanguage?: string | null;
  transcript: string;
}

export interface ResolveDirectionResult {
  sourceLanguage: string;
  targetLanguage: string;
  sourcePanel: 'first' | 'second' | 'unknown';
  status: 'resolved' | 'language-mismatch' | 'manual-required';
  inferredFromPrevious?: boolean;
}

function detectScriptLanguage(text: string): string | null {
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta'; // Tamil
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te'; // Telugu
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kn'; // Kannada
  if (/[\u0D00-\u0D7F]/.test(text)) return 'ml'; // Malayalam
  if (/[\u0B00-\u0B7F]/.test(text)) return 'or'; // Odia / Odiya
  if (/[\u0980-\u09FF]/.test(text)) return 'bn'; // Bengali
  if (/[\u0A00-\u0A7F]/.test(text)) return 'pa'; // Punjabi (Gurmukhi)
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gu'; // Gujarati
  if (/[\u0900-\u097F]/.test(text)) return 'hi'; // Devanagari (Hindi, Marathi, Bhojpuri)
  if (/[\u0600-\u06FF]/.test(text)) return 'ar'; // Shahmukhi / Arabic / Urdu
  if (/[\u0D80-\u0DFF]/.test(text)) return 'si'; // Sinhalese
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh'; // Chinese (Hanzi)
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja'; // Japanese
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko'; // Korean
  if (/[\u0590-\u05FF]/.test(text)) return 'he'; // Hebrew
  if (/[\u1B00-\u1B7F]/.test(text)) return 'ban'; // Balinese script
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th'; // Thai
  return null;
}

function detectLatinLanguage(text: string): string | null {
  // Spanish
  if (/\b(el|la|los|las|un|una|y|en|que|de|por|para|con|si|hola|gracias|buenos|dias)\b/i.test(text)) {
    return 'es';
  }
  // French
  if (/\b(le|la|les|un|une|et|en|que|de|pour|avec|oui|non|bonjour|merci|s'il|vous|plait)\b/i.test(text)) {
    return 'fr';
  }
  // Portuguese
  if (/\b(o|a|os|as|um|uma|e|em|que|de|para|com|sim|nao|ola|obrigado|bom|dia)\b/i.test(text)) {
    return 'pt';
  }
  // Indonesian / Balinese / Malay Latin
  if (/\b(dan|di|ke|yang|ini|itu|dengan|untuk|iya|tidak|halo|terima|kasih|selamat|pagi)\b/i.test(text)) {
    return 'id';
  }
  // English (broad set covering accents — the words are the same regardless of accent)
  if (/\b(the|and|this|that|with|you|your|what|how|where|please|hello|yes|no|good|morning|evening|welcome|speak|translate|conversation|i|is|it|he|she|we|they|my|but|not|have|has|been|will|would|could|should|about|like|just|very|really|know|think|want|need|come|going|here|there|some|from)\b/i.test(text)) {
    return 'en';
  }
  return null;
}

/**
 * Pure utility to resolve conversation direction based on speech detection.
 * This function NEVER returns 'manual-required' — if nothing else works,
 * it defaults to the first language as source (the user's native language).
 */
export function resolveConversationDirection({
  detectedLanguage,
  firstLanguage,
  secondLanguage,
  previousDetectedLanguage,
  transcript
}: ResolveDirectionParams): ResolveDirectionResult {
  const normFirst = firstLanguage.toLowerCase().trim();
  const normSecond = secondLanguage.toLowerCase().trim();

  // Try to infer language directly from character sets or stop words first
  let resolvedLang = detectedLanguage?.toLowerCase().trim() || null;
  // Treat empty string as null
  if (resolvedLang === '') resolvedLang = null;

  // 1. Try script detection first for non-latin scripts
  const scriptLang = detectScriptLanguage(transcript);
  if (scriptLang) {
    if (scriptLang === 'hi') {
      // Devanagari could be Hindi, Marathi, or Bhojpuri — pick whichever is in the pair
      if (normFirst === 'mr' || normSecond === 'mr') resolvedLang = 'mr';
      else if (normFirst === 'bho' || normSecond === 'bho') resolvedLang = 'bho';
      else resolvedLang = 'hi';
    } 
    else if (scriptLang === 'ar') {
      // Arabic script could be Urdu or Arabic — pick whichever is in the pair
      if (normFirst === 'ur' || normSecond === 'ur') resolvedLang = 'ur';
      else resolvedLang = 'ar';
    }
    else if (scriptLang === 'kn') {
      // Kannada script could be Tulu
      if (normFirst === 'tcy' || normSecond === 'tcy') resolvedLang = 'tcy'; // Tulu
      else resolvedLang = 'kn';
    }
    else {
      resolvedLang = scriptLang;
    }
  }

  // 2. Try Latin stop words if still unresolved
  if (!resolvedLang) {
    const latinLang = detectLatinLanguage(transcript);
    if (latinLang) {
      if (latinLang === 'id' && (normFirst === 'ban' || normSecond === 'ban')) {
        resolvedLang = 'ban'; // Balinese Latin
      } else {
        resolvedLang = latinLang;
      }
    }
  }

  // Rule 1: Matches first language
  if (resolvedLang === normFirst) {
    return {
      sourceLanguage: firstLanguage,
      targetLanguage: secondLanguage,
      sourcePanel: 'first',
      status: 'resolved'
    };
  }

  // Rule 2: Matches second language
  if (resolvedLang === normSecond) {
    return {
      sourceLanguage: secondLanguage,
      targetLanguage: firstLanguage,
      sourcePanel: 'second',
      status: 'resolved'
    };
  }

  // Rule 3: Detected language is outside the selected pair — only fire mismatch
  // if we have a REAL detected language (not empty)
  if (resolvedLang !== null && resolvedLang !== '') {
    return {
      sourceLanguage: resolvedLang,
      targetLanguage: '',
      sourcePanel: 'unknown',
      status: 'language-mismatch'
    };
  }

  // Rule 4: No detected language — try previous turn fallback
  if (previousDetectedLanguage) {
    const normPrev = previousDetectedLanguage.toLowerCase().trim();
    if (normPrev === normFirst) {
      return {
        sourceLanguage: firstLanguage,
        targetLanguage: secondLanguage,
        sourcePanel: 'first',
        status: 'resolved',
        inferredFromPrevious: true
      };
    }
    if (normPrev === normSecond) {
      return {
        sourceLanguage: secondLanguage,
        targetLanguage: firstLanguage,
        sourcePanel: 'second',
        status: 'resolved',
        inferredFromPrevious: true
      };
    }
  }

  // Rule 5: FINAL FALLBACK — default to first language (user's top language) 
  // instead of showing a broken modal with empty language name.
  // This is the key fix: we never show "Unknown Language Detected" with ""
  return {
    sourceLanguage: firstLanguage,
    targetLanguage: secondLanguage,
    sourcePanel: 'first',
    status: 'resolved',
    inferredFromPrevious: true
  };
}
