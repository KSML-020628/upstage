import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SKKU Exchange Atlas",
  description: "성균관대학교 학생을 위한 교환대학 탐색 서비스",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
