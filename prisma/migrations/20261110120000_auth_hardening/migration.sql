-- Account lockout and two-factor sign-in
ALTER TABLE "users" ADD COLUMN "failedLogins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lockedUntil" TIMESTAMP(3),
ADD COLUMN "totpSecret" TEXT,
ADD COLUMN "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN "totpLastStep" INTEGER,
ADD COLUMN "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
