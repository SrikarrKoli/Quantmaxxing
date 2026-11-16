-- Browser-generated run id, so a retried upload doesn't save the same solo run twice.
ALTER TABLE practice_runs ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX practice_runs_client ON practice_runs (uid, client_id) WHERE client_id IS NOT NULL;
