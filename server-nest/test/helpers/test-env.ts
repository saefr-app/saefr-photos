// HTTP tests use a synthetic, explicit loopback origin; production requires configuration.
process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
