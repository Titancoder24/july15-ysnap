import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.0";
import {
  checkRateLimit,
  corsHeaders,
  formatError,
  formatResponse,
  handleCors,
  logUsageEvent,
  verifyUser,
  getSecret,
} from "../shared/index.ts";

const MEDIA_BUCKET = "media";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function audioExtension(file: File): string {
  if (file.type.includes("webm")) return "webm";
  if (file.type.includes("wav")) return "wav";
  if (file.type.includes("mp4") || file.type.includes("m4a")) return "m4a";
  if (file.type.includes("ogg")) return "ogg";
  return "mp3";
}

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const userId = await verifyUser(req);
    checkRateLimit(userId, 20, 60_000);

    const [apiKey, apiBaseUrl, openRouterApiKey] = await Promise.all([
      getSecret("ELEVENLABS_API_KEY"),
      getSecret("ELEVENLABS_API_BASE_URL").catch(() => "https://api.elevenlabs.io"),
      getSecret("OPENROUTER_API_KEY"),
    ]);

    if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      return formatError("Invalid Content-Type. Must be multipart/form-data");
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const voiceId = formData.get("voice_id")?.toString().trim();
    const saveToStorage = formData.get("save_to_storage")?.toString() !== "false";
    const requestedSessionId = formData.get("session_id")?.toString().trim();

    if (!(file instanceof File)) return formatError("Missing parameter: 'file' is required");
    if (!voiceId) return formatError("Missing parameter: 'voice_id' is required");
    if (file.size === 0) return formatError("The recorded audio file is empty");
    if (file.size > MAX_AUDIO_BYTES) return formatError("Audio file exceeds the 20MB limit");

    const voiceForm = new FormData();
    voiceForm.append("audio", file, file.name || "input-audio");
    voiceForm.append("model_id", "eleven_multilingual_sts_v2");
    voiceForm.append("remove_background_noise", "true");
    voiceForm.append("voice_settings", JSON.stringify({
      stability: 0.5,
      similarity_boost: 0.8,
      use_speaker_boost: true,
    }));

    // Use OpenRouter Whisper transcription (sub-1s latency) instead of slow ElevenLabs speech-to-text
    const sttFormData = new FormData();
    sttFormData.append("file", file, file.name || "input-audio");
    sttFormData.append("model", "openai/whisper-large-v3-turbo");
    sttFormData.append("response_format", "verbose_json");

    const [voiceResponse, transcriptResponse] = await Promise.all([
      fetch(
        `${apiBaseUrl}/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        { method: "POST", headers: { "xi-api-key": apiKey }, body: voiceForm },
      ),
      fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openRouterApiKey}` },
        body: sttFormData,
      }),
    ]);

    if (!voiceResponse.ok) {
      throw new Error(`ElevenLabs Voice Changer failed (${voiceResponse.status}): ${await voiceResponse.text()}`);
    }

    const transcript = transcriptResponse.ok ? await transcriptResponse.json() : null;
    const sourceText = String(transcript?.text || "Voice conversion").trim();
    const languageCode = String(transcript?.language || "und");
    const audioBuffer = await voiceResponse.arrayBuffer();

    await logUsageEvent(userId, "voice_change", file.size, "bytes", {
      target_voice_id: voiceId,
      output_size_bytes: audioBuffer.byteLength,
    });

    if (!saveToStorage) {
      return new Response(audioBuffer, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audioBuffer.byteLength),
        },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    let sessionId = requestedSessionId || "";
    if (sessionId) {
      const { data: session } = await supabase
        .from("translation_sessions")
        .select("id,user_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (!session || session.user_id !== userId) {
        return formatError("Voice-change session was not found for this user", 404);
      }
    } else {
      const { data: session, error } = await supabase
        .from("translation_sessions")
        .insert({
          user_id: userId,
          session_type: "voice_change",
          source_language: languageCode,
          target_language: languageCode,
          title: `Accent and voice change: ${sourceText.slice(0, 60)}`,
          status: "completed",
          metadata: { provider: "elevenlabs", target_voice_id: voiceId },
        })
        .select("id")
        .single();
      if (error || !session) throw new Error(`Failed to create voice-change session: ${error?.message}`);
      sessionId = session.id;
    }

    const inputPath = `voice_inputs/${userId}/${crypto.randomUUID()}.${audioExtension(file)}`;
    const outputPath = `voice_outputs/${userId}/${crypto.randomUUID()}.mp3`;
    const outputBlob = new Blob([audioBuffer], { type: "audio/mpeg" });

    const [{ error: inputError }, { error: outputError }] = await Promise.all([
      supabase.storage.from(MEDIA_BUCKET).upload(inputPath, file, {
        contentType: file.type || "audio/mpeg",
        cacheControl: "3600",
        upsert: false,
      }),
      supabase.storage.from(MEDIA_BUCKET).upload(outputPath, outputBlob, {
        contentType: "audio/mpeg",
        cacheControl: "3600",
        upsert: false,
      }),
    ]);
    if (inputError || outputError) {
      throw new Error(`Failed to save voice-change audio: ${inputError?.message || outputError?.message}`);
    }

    const { error: mediaError } = await supabase.from("media_assets").insert([
      {
        user_id: userId,
        session_id: sessionId,
        media_kind: "voice_input",
        bucket: MEDIA_BUCKET,
        path: inputPath,
        mime_type: file.type || "audio/mpeg",
        size_bytes: file.size,
        retention_policy: "session",
      },
      {
        user_id: userId,
        session_id: sessionId,
        media_kind: "voice_output",
        bucket: MEDIA_BUCKET,
        path: outputPath,
        mime_type: "audio/mpeg",
        size_bytes: outputBlob.size,
        retention_policy: "session",
      },
    ]);
    if (mediaError) throw new Error(`Failed to save media records: ${mediaError.message}`);

    // Query sequence number dynamically to support multiple turns in same session
    let sequenceNumber = 1;
    const { data: lastItem } = await supabase
      .from("translation_items")
      .select("sequence_number")
      .eq("session_id", sessionId)
      .order("sequence_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastItem) {
      sequenceNumber = lastItem.sequence_number + 1;
    }

    const { error: itemError } = await supabase.from("translation_items").insert({
      session_id: sessionId,
      user_id: userId,
      speaker_id: "user",
      sequence_number: sequenceNumber,
      source_text: sourceText,
      translated_text: sourceText,
      detected_language: languageCode,
      source_language: languageCode,
      target_language: languageCode,
      source_audio_path: inputPath,
      generated_audio_path: outputPath,
      context_notes: `Converted with ElevenLabs voice ${voiceId}`,
    });
    if (itemError) throw new Error(`Failed to save voice-change history: ${itemError.message}`);

    const [{ data: inputUrl }, { data: outputUrl }] = await Promise.all([
      supabase.storage.from(MEDIA_BUCKET).createSignedUrl(inputPath, 86_400),
      supabase.storage.from(MEDIA_BUCKET).createSignedUrl(outputPath, 86_400),
    ]);

    return formatResponse({
      url: outputUrl?.signedUrl || null,
      filePath: outputPath,
      mediaAssetId: null,
      sessionId,
      sourceAudioUrl: inputUrl?.signedUrl || null,
      sourceText,
    });
  } catch (error) {
    return formatError(error);
  }
});
