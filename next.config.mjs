/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone so the Docker image ships only what it needs.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Keep the Prisma engine out of the traced bundle analysis noise.
    serverComponentsExternalPackages: ['@prisma/client', '@google/genai'],
    // Enables src/instrumentation.ts, which starts the in-process scheduler.
    instrumentationHook: true,
  },
};

export default nextConfig;
