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
  const normDetected = detectedLanguage?.toLowerCase().trim() || null;
  const normFirst = firstLanguage.toLowerCase().trim();
  const normSecond = secondLanguage.toLowerCase().trim();

  // Rule 1: Matches first language
  if (normDetected === normFirst) {
    return {
      sourceLanguage: firstLanguage,
      targetLanguage: secondLanguage,
      sourcePanel: 'first',
      status: 'resolved'
    };
  }

  // Rule 2: Matches second language
  if (normDetected === normSecond) {
    return {
      sourceLanguage: secondLanguage,
      targetLanguage: firstLanguage,
      sourcePanel: 'second',
      status: 'resolved'
    };
  }

  // Rule 3: Detected language is outside the selected pair
  if (normDetected !== null) {
    return {
      sourceLanguage: '',
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
