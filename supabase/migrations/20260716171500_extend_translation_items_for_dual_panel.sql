-- Extend translation_items table with additional fields for dual-panel, single-mic conversation tracking.
ALTER TABLE public.translation_items 
ADD COLUMN IF NOT EXISTS source_panel text,
ADD COLUMN IF NOT EXISTS detection_mode text,
ADD COLUMN IF NOT EXISTS detected_language_name text,
ADD COLUMN IF NOT EXISTS transcription_error text,
ADD COLUMN IF NOT EXISTS translation_error text,
ADD COLUMN IF NOT EXISTS speech_error text,
ADD COLUMN IF NOT EXISTS status text DEFAULT 'complete';
