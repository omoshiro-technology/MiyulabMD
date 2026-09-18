-- Per-user settings store (JSON). Knowledge-management feature flags live
-- under {"knowledge": {"para": bool, "schemes": bool, "layers": bool}}.
-- See specs/knowledge-management.html §2.3 (users.settings is the authority;
-- client-side sessionStorage/localStorage are mirrors/hints only).

ALTER TABLE users ADD COLUMN settings TEXT;
