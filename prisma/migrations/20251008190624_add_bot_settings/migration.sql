-- CreateTable
CREATE TABLE "BotSettings" (
    "id" TEXT NOT NULL,
    "personality" TEXT NOT NULL DEFAULT 'divertido',
    "language" TEXT NOT NULL DEFAULT 'pt',
    "autoJokes" BOOLEAN NOT NULL DEFAULT true,
    "autoTime" BOOLEAN NOT NULL DEFAULT true,
    "autoGreeting" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotSettings_pkey" PRIMARY KEY ("id")
);
