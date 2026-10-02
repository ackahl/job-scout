import type { Metadata, Viewport } from "next";
import "@fontsource/anton/400.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/barlow-condensed/800-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Scout | Max Payroll",
  description: "Max Payroll, the Salary Cap Crusher, storms company job boards and puts every opening and its pay on the table.",
};

export const viewport: Viewport = { themeColor: "#07060a" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
