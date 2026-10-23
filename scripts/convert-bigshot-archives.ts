import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPgnFromZip } from "./lib/pgnArchive";

function readOption(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

async function main(): Promise<void> {
  const inputDir = path.resolve(process.cwd(), readOption("--input", "../maia/chess_pgn_zips"));
  const outputDir = path.resolve(process.cwd(), readOption("--output", "data/bigshots/converted"));
  const files = (await readdir(inputDir)).filter((file) => file.toLocaleLowerCase().endsWith(".zip")).sort();

  if (files.length === 0) {
    throw new Error(`No ZIP archives found in ${inputDir}`);
  }

  await mkdir(outputDir, { recursive: true });
  const manifest: Array<{ archive: string; output: string; archiveBytes: number; pgnBytes: number; gameHeaders: number }> = [];

  for (const file of files) {
    const archivePath = path.join(inputDir, file);
    const pgn = await readPgnFromZip(archivePath);
    const outputName = `${path.basename(file, path.extname(file))}.pgn`;
    const outputPath = path.join(outputDir, outputName);
    await writeFile(outputPath, pgn, "utf8");
    const archiveStats = await stat(archivePath);
    const gameHeaders = (pgn.match(/^\[Event\s/mg) ?? []).length;
    manifest.push({ archive: file, output: outputName, archiveBytes: archiveStats.size, pgnBytes: Buffer.byteLength(pgn), gameHeaders });
    console.log(`${file} -> ${outputName} (${gameHeaders} game headers)`);
  }

  await writeFile(path.join(outputDir, "conversion-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Converted ${manifest.length} archives into ${outputDir}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
