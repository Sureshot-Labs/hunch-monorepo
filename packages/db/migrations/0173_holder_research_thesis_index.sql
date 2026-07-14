CREATE INDEX IF NOT EXISTS idx_ai_notes_holder_research_thesis
  ON ai_notes ((lineage->>'thesis_key'), created_at DESC)
  WHERE note_type = 'signal'
    AND producer_type = 'holder_research'
    AND lineage ? 'thesis_key';
