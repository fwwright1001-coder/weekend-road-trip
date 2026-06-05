-- Weekend Road Trip - Road Crew signup table
-- The Vercel function in api/waitlist.js creates this automatically, but this
-- file documents the Neon table a reviewer should see after the first signup.

CREATE TABLE IF NOT EXISTS email_signups (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  interest text NOT NULL DEFAULT 'road-crew',
  source text NOT NULL DEFAULT 'weekend-road-trip',
  score integer,
  user_agent text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_signups_created_at_idx
  ON email_signups (created_at DESC);

CREATE INDEX IF NOT EXISTS email_signups_interest_idx
  ON email_signups (interest);
