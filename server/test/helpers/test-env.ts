// HTTP tests use a synthetic, explicit loopback origin; production requires configuration.
process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
process.env.POSTGRES_HOST = '127.0.0.1';
process.env.POSTGRES_DB = 'saefr_isolated_e2e';
process.env.POSTGRES_USER = 'saefr_isolated_e2e';
process.env.POSTGRES_PASSWORD = 'synthetic-e2e-only';
