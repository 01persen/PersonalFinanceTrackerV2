import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { AppProviders } from "@/app/providers";

export const metadata: Metadata = {
  title: "Personal Finance Tracker",
  description: "Catat keuangan pribadi, lebih cepat dari spreadsheet.",
  applicationName: "Personal Finance Tracker",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
