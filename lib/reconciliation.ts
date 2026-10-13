/** Pending signatures remain reserved even after their blockhash expires. */
export function reconciliationAction(
  status: { confirmationStatus?: string | null } | null,
  finalizedHeight: number,
  lastValidHeight: number,
): "finalize" | "wait" | "expire" | "retry" {
  if (status?.confirmationStatus === "finalized") return "finalize";
  if (status) return "wait";
  return finalizedHeight > lastValidHeight ? "expire" : "retry";
}
