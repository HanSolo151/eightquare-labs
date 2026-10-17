/*
  Warnings:

  - Added the required column `ratio` to the `FlaggedMove` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "FlaggedMove" ADD COLUMN     "ratio" DOUBLE PRECISION NOT NULL;
