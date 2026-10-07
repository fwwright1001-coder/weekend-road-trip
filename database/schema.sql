-- Weekend Road Trip - cloud high-score table
-- The Vercel function in api/highscores.js creates this automatically, but this
-- file documents the Neon table a reviewer should see after the first run.

CREATE TABLE IF NOT EXISTS game_high_scores (
  id bigserial PRIMARY KEY,
  initials text NOT NULL,
  score integer NOT NULL,
  source text NOT NULL DEFAULT 'weekend-road-trip',
  user_agent text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_high_scores_score_idx
  ON game_high_scores (score DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS game_high_scores_created_at_idx
  ON game_high_scores (created_at DESC);
