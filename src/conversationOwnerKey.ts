/** Mechanically derive a durable owner-search key only for a singleton authorized identity. */
export function deriveConversationOwnerKey(
  surfaceIdentity: string,
  allowedUserIds: ReadonlySet<string>,
): string | null {
  const surface = surfaceIdentity.trim();
  if (!surface || allowedUserIds.size !== 1) return null;
  const ownerId = allowedUserIds.values().next().value?.trim();
  return ownerId ? JSON.stringify([surface, ownerId]) : null;
}
