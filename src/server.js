const env = require('./config/env');
const app = require('./app');
const prisma = require('./lib/prisma');

const server = app.listen(env.PORT, () => {
  console.log(`Sampai Mana API berjalan di port ${env.PORT} (${env.NODE_ENV})`);
});

const shutdown = (signal) => {
  console.log(`${signal} diterima, menutup server…`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
