import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  distDir: 'otel-output',
  experimental: { devAndBuildOtel: true },
}

export default nextConfig
