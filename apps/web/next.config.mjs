/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/studio",
        destination: "/studio/index.html",
      },
    ];
  },
};

export default nextConfig;
