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
  if (/[\u0900-\u097F]/.test(text)) return 'hi'; // Hindi
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te'; // Telugu
  if (/[\u0600-\u06FF]/.test(text)) return 'ar'; // Arabic
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)) return 'ja'; // Japanese
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko'; // Korean
  return null;
}

function containsEnglishStopwords(text: string): boolean {
  const stopwords = /\b(the|and|this|that|with|you|your|what|how|where|please|hello|yes|no|good|morning|evening|welcome|speak|translate|conversation)\b/i;
  return stopwords.test(text);
}

/**
 * pure utility to resolve conversation direction based on speech detection.
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

  const scriptLang = detectScriptLanguage(transcript);
  if (scriptLang && (scriptLang === normFirst || scriptLang === normSecond)) {
    resolvedLang = scriptLang;
  }

  // Fallback: If no language is detected but transcript has English stop words
  if (!resolvedLang && containsEnglishStopwords(transcript)) {
    if (normFirst === 'en' || normSecond === 'en') {
      resolvedLang = 'en';
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

  // Rule 3: Detected language is outside the selected pair
  if (resolvedLang !== null) {
    return {
      sourceLanguage: resolvedLang, // Populate mismatched language code
      targetLanguage: '',
      sourcePanel: 'unknown',
      status: 'language-mismatch'
    };
  }

  // Rule 4: No detected language (e.g. whisper didn't return language or raw audio is extremely short)
  const wordCount = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  const isShortOrAmbiguous = wordCount <= 3;

  if (isShortOrAmbiguous && previousDetectedLanguage) {
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

  // Rule 5: Otherwise manual resolution is needed
  return {
    sourceLanguage: '',
    targetLanguage: '',
    sourcePanel: 'unknown',
    status: 'manual-required'
  };
}
