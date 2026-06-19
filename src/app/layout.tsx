import type { Metadata, Viewport } from "next";

import "streamdown/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "My Agent",
  description: "ChatGPT-like web agent powered by DeepSeek.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
