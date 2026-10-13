import { z } from "zod";
export const publicKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const url = z
  .union([
    z.literal(""),
    z.url().refine((s) => s.startsWith("https://"), "Use an HTTPS URL."),
  ])
  .default("");
export const metadataSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .refine((s) => Buffer.byteLength(s) <= 32),
  ticker: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .regex(/^[a-zA-Z0-9]+$/)
    .transform((s) => s.toUpperCase()),
  twitter: url.refine(
    (s) =>
      !s ||
      ["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(
        new URL(s).hostname,
      ),
  ),
  website: url,
});
