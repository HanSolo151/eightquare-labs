import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const stockfishBinDir = path.join(process.cwd(), "node_modules", "stockfish", "bin");
const ALLOWED_ASSETS = new Set([
  "stockfish-19-lite-single.js",
  "stockfish-19-lite-single.wasm",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ asset: string }> }
) {
  const { asset } = await params;
  if (!ALLOWED_ASSETS.has(asset)) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  try {
    const contents = await readFile(path.join(stockfishBinDir, asset));
    return new NextResponse(new Uint8Array(contents), {
      headers: {
        "Content-Type": asset.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("Unable to read Stockfish browser asset:", error);
    return NextResponse.json({ error: "Stockfish asset unavailable" }, { status: 500 });
  }
}