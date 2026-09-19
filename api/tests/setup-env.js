// Tests never need real credentials: give the config schema harmless values when a developer has no .env.
process.env.GEMINI_API_KEY ||= 'test-key-not-real';
process.env.DATABASE_URL ||= 'postgresql://postgres:postgres@localhost:5432/gridwatch_unit_tests_unused';
process.env.LOG_LEVEL ||= 'silent';
