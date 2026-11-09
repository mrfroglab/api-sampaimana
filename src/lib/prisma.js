const { PrismaClient } = require('@prisma/client');
const env = require('../config/env');

const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

module.exports = prisma;
