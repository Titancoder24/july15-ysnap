import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.0";
import {
  checkRateLimit,
  formatError,
  formatResponse,
  GEMINI_MODEL,
  generateTextResult,
  generateMultimodalResult,
  handleCors,
  logUsageEvent,
  verifyUser,
  getSecret,
  safeParseAIJson,
} from "../shared/index.ts";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MEDIA_BUCKET = "media";

function audioExtension(file: File): string {
  const mime = file?.type || "";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "mp3";
}

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const userId = await verifyUser(req);
    checkRateLimit(userId, 20, 60_000);

    const [elevenLabsApiKey, elevenLabsApiBaseUrl, openRouterApiKey] = await Promise.all([
      getSecret("ELEVENLABS_API_KEY"),
      getSecret("ELEVENLABS_API_BASE_URL").catch(() => "https://api.elevenlabs.io"),
      getSecret("OPENROUTER_API_KEY"),
    ]);

    if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      return formatError("Invalid Content-Type. Must be multipart/form-data");
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const target = formData.get("target")?.toString().trim();
    const source = formData.get("source")?.toString().trim() || "auto";
    let voiceId = formData.get("voice_id")?.toString().trim() ||
      "21m00Tcm4TlvDq8ikWAM";
    const requestedSessionId = formData.get("session_id")?.toString().trim();
    const requestedSessionType = formData.get("session_type")?.toString();
    const sessionType = requestedSessionType === "conversation" ? "conversation" : "voice";
    const speakerId = formData.get("speaker_id")?.toString().trim() || "user";
    const requestedSequence = Number(formData.get("sequence_number")?.toString() || "0");

    if (!(file instanceof File)) return formatError("Missing parameter: 'file' is required");
    if (!target) return formatError("Missing parameter: 'target' language is required");
    if (file.size === 0) return formatError("The recorded audio file is empty");
    if (file.size > MAX_AUDIO_BYTES) {
      return formatError(`Audio file exceeds the ${MAX_AUDIO_BYTES / 1024 / 1024}MB limit`);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    // Default to the user's custom cloned voice if they have one and the request uses the default voice
    if (voiceId === "21m00Tcm4TlvDq8ikWAM") {
      const { data: customVoice } = await supabase
        .from("voice_profiles")
        .select("provider_voice_id")
        .eq("user_id", userId)
        .eq("status", "ready")
        .limit(1)
        .maybeSingle();
      if (customVoice?.provider_voice_id) {
        console.log(`Auto-defaulting to user's cloned voice: ${customVoice.provider_voice_id}`);
        voiceId = customVoice.provider_voice_id;
      } else {
        console.log("No cloned voice found. Using default preset system voice (Rachel)...");
      }
    }

    let sessionId = requestedSessionId || "";
    let createdSession = false;

    if (sessionId) {
      const { data: session, error } = await supabase
        .from("translation_sessions")
        .select("id,user_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (error || !session || session.user_id !== userId) {
        return formatError("Translation session was not found for this user", 404);
      }
    } else {
      const { data: session, error } = await supabase
        .from("translation_sessions")
        .insert({
          user_id: userId,
          session_type: sessionType,
          source_language: source,
          target_language: target,
          title: sessionType === "conversation" ? "Voice conversation" : `Voice translation to ${target}`,
          status: sessionType === "conversation" ? "active" : "completed",
          metadata: {
            speech_provider: "elevenlabs",
            stt_model: "whisper-large-v3-turbo",
            tts_model: "eleven_multilingual_v2",
            translation_provider: "google",
            translation_model: GEMINI_MODEL,
            voice_id: voiceId,
          },
        })
        .select("id")
        .single();
      if (error || !session) throw new Error(`Failed to create translation session: ${error?.message}`);
      sessionId = session.id;
      createdSession = true;
    }

    let sequenceNumber = Number.isFinite(requestedSequence) && requestedSequence > 0
      ? Math.floor(requestedSequence)
      : 0;
    if (!sequenceNumber) {
      const { data: lastItem } = await supabase
        .from("translation_items")
        .select("sequence_number")
        .eq("session_id", sessionId)
        .order("sequence_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      sequenceNumber = (lastItem?.sequence_number || 0) + 1;
    }

    const extension = audioExtension(file);
    const inputAudioPath = `voice_inputs/${userId}/${crypto.randomUUID()}.${extension}`;
    const { error: inputUploadError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(inputAudioPath, file, {
        contentType: file.type || "audio/mpeg",
        cacheControl: "3600",
        upsert: false,
      });
    if (inputUploadError) throw new Error(`Failed to save source audio: ${inputUploadError.message}`);

    let sourceText = "";
    let translatedText = "";
    let detectedLanguage = "unknown";
    let translationModel = "";

    try {
      console.log("Attempting direct multimodal audio translation with Gemini 3.5 Flash...");
      const audioBuffer = await file.arrayBuffer();
      const audioBytes = new Uint8Array(audioBuffer);
      const mimeType = file.type || "audio/mpeg";

      const prompt = `Transcribe the spoken audio and translate it into ${target}. 
Return one valid JSON object with exactly these keys:
- source_text (string): the exact transcription of the spoken words in the original language.
- translated_text (string): the translation of that transcription into ${target}.
- detected_language (string): the detected language code or name.`;

      const systemInstruction = "You are a precise conversational speech-to-text translator. Return one valid JSON object with the keys source_text, translated_text, and detected_language. Do not add markdown or formatting.";

      const generated = await generateMultimodalResult(
        audioBytes,
        mimeType,
        prompt,
        systemInstruction,
        true
      );

      const parsed = safeParseAIJson<{
        source_text: string;
        translated_text: string;
        detected_language?: string;
      }>(generated.text, {
        source_text: 'string',
        translated_text: 'string',
        detected_language: 'string'
      });

      sourceText = String(parsed.source_text || "").trim();
      translatedText = String(parsed.translated_text || "").trim();
      detectedLanguage = String(parsed.detected_language || "unknown");
      translationModel = generated.model;
      
      console.log(`Multimodal speech translation success! Latency optimized. Source: "${sourceText}", Target: "${translatedText}"`);
    } catch (multimodalError) {
      console.warn("Direct multimodal audio translation failed, falling back to Whisper + Gemini text pipeline:", multimodalError);
      
      // Fallback: Use Whisper STT on OpenRouter
      const sttFormData = new FormData();
      sttFormData.append("file", file, file.name || `input.${extension}`);
      sttFormData.append("model", "openai/whisper-large-v3-turbo");
      sttFormData.append("response_format", "verbose_json");
      if (source !== "auto") sttFormData.append("language", source);

      const sttResponse = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openRouterApiKey}` },
        body: sttFormData,
      });
      if (!sttResponse.ok) {
        throw new Error(`Whisper transcription failed (${sttResponse.status}): ${await sttResponse.text()}`);
      }

      const sttResult = await sttResponse.json();
      sourceText = String(sttResult.text || "").trim();
      if (!sourceText) throw new Error("No speech was detected in the recording");
      detectedLanguage = String(sttResult.language || source || "unknown");

      const textPrompt = `Translate from ${source === "auto" ? detectedLanguage : source} to ${target}:\n\n${sourceText}`;
      const systemInstruction = `You are a precise conversational translator. Return one valid JSON object with these keys: translated_text (string), detected_language (ISO language code). Translate naturally into ${target}. Do not add markdown.`;
      
      const generatedText = await generateTextResult(textPrompt, systemInstruction, true);
      const parsedText = safeParseAIJson<{ translated_text: string }>(generatedText.text, { translated_text: 'string' });
      
      translatedText = String(parsedText.translated_text || generatedText.text).trim();
      translationModel = generatedText.model;
    }

    if (!sourceText) throw new Error("No speech was detected in the recording");
    if (!translatedText) throw new Error("The translation provider returned an empty translation");

    await logUsageEvent(userId, "transcription", file.size, "bytes", {
      session_id: sessionId,
      language_code: detectedLanguage,
      text_length: sourceText.length,
    });

    await logUsageEvent(userId, "translation", sourceText.length, "characters", {
      session_id: sessionId,
      source_language: source,
      target_language: target,
      provider: "google",
      model: translationModel,
    });

    // Use eleven_multilingual_v2 (Low-latency multilingual model) instead of slow eleven_v3
    const ttsResponse = await fetch(
      `${elevenLabsApiBaseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": elevenLabsApiKey },
        body: JSON.stringify({
          text: translatedText,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            use_speaker_boost: true,
          },
        }),
      },
    );
    if (!ttsResponse.ok) {
      throw new Error(`ElevenLabs speech generation failed (${ttsResponse.status}): ${await ttsResponse.text()}`);
    }

    const outputBuffer = await ttsResponse.arrayBuffer();
    const outputBlob = new Blob([outputBuffer], { type: "audio/mpeg" });
    const outputAudioPath = `voice_outputs/${userId}/${crypto.randomUUID()}.mp3`;
    const { error: outputUploadError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(outputAudioPath, outputBlob, {
        contentType: "audio/mpeg",
        cacheControl: "3600",
        upsert: false,
      });
    if (outputUploadError) throw new Error(`Failed to save translated audio: ${outputUploadError.message}`);

    const { error: mediaError } = await supabase.from("media_assets").insert([
      {
        user_id: userId,
        session_id: sessionId,
        media_kind: "voice_input",
        bucket: MEDIA_BUCKET,
        path: inputAudioPath,
        mime_type: file.type || "audio/mpeg",
        size_bytes: file.size,
        retention_policy: "session",
      },
      {
        user_id: userId,
        session_id: sessionId,
        media_kind: "voice_output",
        bucket: MEDIA_BUCKET,
        path: outputAudioPath,
        mime_type: "audio/mpeg",
        size_bytes: outputBlob.size,
        retention_policy: "session",
      },
    ]);

    const { data: translationItem, error: itemError } = await supabase
      .from("translation_items")
      .insert({
        session_id: sessionId,
        user_id: userId, // <-- SET USER ID SO RLS SELECT POLICIES CAN SYNC LOGS HISTORY DRAWERS!
        sequence_number: sequenceNumber,
        speaker_id: speakerId,
        source_text: sourceText,
        translated_text: translatedText,
        transliteration: null,
        detected_language: detectedLanguage,
        alternatives: [],
        context_notes: null,
        source_audio_path: inputAudioPath,
        generated_audio_path: outputAudioPath,
      })
      .select("id")
      .single();
    if (itemError || !translationItem) throw new Error(`Failed to save translation item: ${itemError?.message}`);

    await logUsageEvent(userId, "tts", outputBlob.size, "bytes", {
      session_id: sessionId,
      voice_id: voiceId,
      output_size_bytes: outputBlob.size,
    });

    const [{ data: sourceUrl }, { data: outputUrl }] = await Promise.all([
      supabase.storage.from(MEDIA_BUCKET).createSignedUrl(inputAudioPath, 86_400),
      supabase.storage.from(MEDIA_BUCKET).createSignedUrl(outputAudioPath, 86_400),
    ]);

    return formatResponse({
      session_id: sessionId,
      translation_item_id: translationItem.id,
      source_text: sourceText,
      translated_text: translatedText,
      transliteration: null,
      detected_language: detectedLanguage,
      alternatives: [],
      context_notes: null,
      translation_model: translationModel,
      source_audio_url: sourceUrl?.signedUrl || null,
      generated_audio_url: outputUrl?.signedUrl || null,
    });
  } catch (error) {
    return formatError(error);
  }
});
