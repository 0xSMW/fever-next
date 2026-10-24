-- ADMIN-ONLY TEMPLATE. Invoke manually after supplying psql variables securely.
-- Do not pass plaintext passwords as command-line -v arguments or commit them.
-- This template fixes the database name to fever. Review before using another name.
CREATE ROLE fever_migrator LOGIN PASSWORD :'migrator_password';
CREATE ROLE fever_runtime LOGIN PASSWORD :'runtime_password';
REVOKE ALL ON DATABASE fever FROM PUBLIC;
GRANT CONNECT ON DATABASE fever TO fever_migrator, fever_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO fever_migrator;
GRANT USAGE ON SCHEMA public TO fever_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE fever_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fever_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE fever_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fever_runtime;
-- The operator must reapply/verify these grants after --no-privileges restore.
