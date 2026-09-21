-- Phones that want push notifications, the suburbs they follow, and a record of every outage change already judged
-- (so a change is only ever announced once, even across restarts and rebuilds).
CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT,
    "quietFrom" INTEGER,
    "quietTo" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PushDevice_quiet_check" CHECK (("quietFrom" IS NULL AND "quietTo" IS NULL) OR ("quietFrom" BETWEEN 0 AND 23 AND "quietTo" BETWEEN 0 AND 23))
);
CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");

CREATE TABLE "PushSubscription" (
    "deviceId" TEXT NOT NULL,
    "localityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("deviceId","localityId")
);
CREATE INDEX "PushSubscription_localityId_idx" ON "PushSubscription"("localityId");
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PushDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_localityId_fkey" FOREIGN KEY ("localityId") REFERENCES "Locality"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "NotificationEvent" (
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "outageId" TEXT,
    "kind" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("postId","faultIndex")
);
CREATE INDEX "NotificationEvent_outageId_createdAt_idx" ON "NotificationEvent"("outageId", "createdAt");
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
