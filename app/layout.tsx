import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BXAGI · 广告素材与投放平台",
  description: "多用户广告素材生产、自动员工调度、预算投放与效果优化平台。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
