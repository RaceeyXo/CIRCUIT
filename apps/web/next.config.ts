import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

// Static export: the site is plain files (GitHub Pages or any static host). There is no server;
// the console talks to the NEAR RPC directly from the browser and holds no keys.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  devIndicators: false,
  poweredByHeader: false,
  // pnpm workspace: let Turbopack resolve @circuit/shared from the monorepo root.
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
};

export default nextConfig;
