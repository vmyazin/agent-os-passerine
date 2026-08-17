ALTER TABLE "usage_records" ALTER COLUMN "pricing_version" SET DEFAULT 'legacy-pricing-v0';
ALTER TABLE "usage_records" ALTER COLUMN "cache_read_input_tokens" SET DEFAULT 0;
ALTER TABLE "usage_records" ALTER COLUMN "cache_creation_5m_input_tokens" SET DEFAULT 0;
ALTER TABLE "usage_records" ALTER COLUMN "cache_creation_1h_input_tokens" SET DEFAULT 0;
