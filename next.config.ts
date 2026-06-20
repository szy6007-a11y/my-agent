import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

function getLocalDevOrigins() {
  return Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter(
      (details) =>
        details.family === "IPv4" && !details.internal && details.address.includes("."),
    )
    .map((details) => details.address);
}

const nextConfig: NextConfig = {
  allowedDevOrigins: getLocalDevOrigins(),
  devIndicators: false,
  reactStrictMode: true,
};

export default nextConfig;
