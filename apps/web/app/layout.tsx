import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Donova — AI Video Editing Studio on the Cloud",
  description:
    "Drop in your raw footage and describe your edit. Donova's cloud AI cuts, captions, and renders your video in your style.",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0a] text-white min-h-screen selection:bg-[#4a8fd8] selection:text-black antialiased">
        {children}
      </body>
    </html>
  );
}
