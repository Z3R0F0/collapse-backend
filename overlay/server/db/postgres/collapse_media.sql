-- Additive, versioned atlas index. No message copies, triggers, or Tinode
-- schema-version changes. Never alter this function in-place after deployment:
-- a changed predicate needs a new version and newly built indexes.
CREATE FUNCTION public.collapse_media_int_v1(value jsonb, fallback integer)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN value IS NULL THEN fallback
    WHEN jsonb_typeof(value) = 'number' AND value::text ~ '^-?[0-9]{1,9}$'
      THEN value::text::integer ELSE NULL END
$$;

CREATE FUNCTION public.collapse_media_items_v1(doc jsonb)
RETURNS TABLE(key integer, kind text, entity jsonb)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  entries jsonb; formats jsonb; candidate jsonb; f jsonb;
  idx integer; at_pos integer; span_len integer; hidden_at integer;
  hidden_len integer; hidden_key integer; hidden_type text;
  hidden_ranges int4range[] := '{}'; emitted integer[] := '{}'; media_type text;
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR jsonb_typeof(doc->'ent') IS DISTINCT FROM 'array'
    OR jsonb_typeof(doc->'fmt') IS DISTINCT FROM 'array' THEN RETURN; END IF;
  entries := doc->'ent'; formats := doc->'fmt';
  -- Resource bound for index maintenance on untrusted message content. More
  -- complex documents remain ordinary messages, but are not atlas candidates.
  IF jsonb_array_length(entries) > 256 OR jsonb_array_length(formats) > 1024 THEN RETURN; END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(formats) LOOP
    hidden_type := f->>'tp';
    IF hidden_type IS NULL THEN
      hidden_key := public.collapse_media_int_v1(f->'key', 0);
      IF hidden_key >= 0 THEN hidden_type := entries->hidden_key->>'tp'; END IF;
    END IF;
    IF hidden_type NOT IN ('QQ', 'QR', 'HD') OR hidden_type IS NULL THEN CONTINUE; END IF;
    hidden_at := public.collapse_media_int_v1(f->'at', 0);
    hidden_len := public.collapse_media_int_v1(f->'len', 0);
    IF hidden_at >= 0 AND hidden_len > 0 THEN
      hidden_ranges := array_append(hidden_ranges, int4range(hidden_at, hidden_at + hidden_len));
    END IF;
  END LOOP;
  -- Direct entity lookup preserves original keys and avoids entity x format x
  -- hidden nested loops. Range overlap is a PostgreSQL builtin, not a parser.
  FOR f IN SELECT value FROM jsonb_array_elements(formats) LOOP
    IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f ? 'tp' THEN CONTINUE; END IF;
    idx := public.collapse_media_int_v1(f->'key', 0);
    IF idx IS NULL OR idx < 0 OR idx = ANY(emitted) THEN CONTINUE; END IF;
    candidate := entries->idx;
    media_type := candidate->>'tp';
    IF media_type NOT IN ('IM', 'VD', 'AU', 'EX') OR media_type IS NULL
      OR jsonb_typeof(candidate->'data') IS DISTINCT FROM 'object' THEN CONTINUE; END IF;
    IF NOT COALESCE((COALESCE(jsonb_typeof(candidate#>'{data,ref}') = 'string' AND
          length(candidate#>>'{data,ref}') > 0, false)
      OR COALESCE(jsonb_typeof(candidate#>'{data,val}') = 'string' AND
          length(candidate#>>'{data,val}') > 0, false)
      OR (jsonb_typeof(candidate#>'{data,val}') = 'array' AND candidate#>'{data,val}' <> '[]')), false)
      THEN CONTINUE; END IF;
    at_pos := public.collapse_media_int_v1(f->'at', 0);
    span_len := public.collapse_media_int_v1(f->'len', 0);
    IF at_pos IS NULL OR span_len IS NULL OR at_pos < -1 OR span_len < 0 THEN CONTINUE; END IF;
    -- An out-of-band attachment has no text range.
    IF at_pos <> -1 AND (span_len = 0 OR
      int4range(at_pos, at_pos + span_len) && ANY(hidden_ranges)) THEN CONTINUE; END IF;
    emitted := array_append(emitted, idx);
    key := idx; entity := candidate;
    kind := CASE media_type WHEN 'IM' THEN 'visual' WHEN 'VD' THEN 'visual'
      WHEN 'AU' THEN 'audio' ELSE 'files' END;
    RETURN NEXT;
  END LOOP;
END
$$;

CREATE FUNCTION public.collapse_media_has_v1(doc jsonb, category text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM public.collapse_media_items_v1(doc) WHERE kind = category)
$$;

CREATE INDEX collapse_media_visual_v1 ON messages(topic, seqid DESC)
  WHERE delid = 0 AND public.collapse_media_has_v1(content::jsonb, 'visual');
CREATE INDEX collapse_media_audio_v1 ON messages(topic, seqid DESC)
  WHERE delid = 0 AND public.collapse_media_has_v1(content::jsonb, 'audio');
CREATE INDEX collapse_media_files_v1 ON messages(topic, seqid DESC)
  WHERE delid = 0 AND public.collapse_media_has_v1(content::jsonb, 'files');
