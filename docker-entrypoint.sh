#!/bin/sh
set -e
# Apply pending migrations (non-destructive), ensure categories/admin, then start.
node_modules/.bin/prisma migrate deploy
node prisma/seed.js
exec node src/server.js
