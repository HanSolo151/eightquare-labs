import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  outputFileTracingIncludes: {
    "/api/stockfish/*": [
      "./node_modules/stockfish/bin/stockfish-19-lite-single.js",
      "./node_modules/stockfish/bin/stockfish-19-lite-single.wasm",
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
