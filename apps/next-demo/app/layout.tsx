import type { Metadata } from "next";
import "../src/styles.css";

export const metadata: Metadata = {
  title: "UI Intelligence — Next.js demo",
  description:
    "The same protocol contracts, runtime kernel, and approved renderers as the Vite reference app.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
