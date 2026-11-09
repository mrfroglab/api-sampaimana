CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "cases_title_trgm_idx" ON "cases" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "cases_case_number_trgm_idx" ON "cases" USING GIN ("caseNumber" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "defendants_name_trgm_idx" ON "defendants" USING GIN ("name" gin_trgm_ops);
