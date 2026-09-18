const noteGenerations = new Map<string, number>();
const userClearGenerations = new Map<string, number>();
const currentShortIds = new Map<string, string>();
let nextGeneration = 1;

function generationKey(userId: string, noteId: string): string {
  return JSON.stringify([userId, noteId]);
}

export function noteIdentityIds(userId: string, id: string): string[] {
  for (const [key, shortId] of currentShortIds) {
    const [owner, canonical] = JSON.parse(key) as [string, string];
    if (owner === userId && (canonical === id || shortId === id)) {
      return [canonical, shortId];
    }
  }
  return [id];
}

// Metadata establishes only the current pair, never a historical alias.
// Joining generations cannot upgrade a caller's original request token.
export function bindNoteIdentity(
  userId: string,
  canonical: string,
  shortId: string,
  orderingToken?: number,
): boolean {
  const generation = Math.max(
    currentNoteReadGeneration(userId, canonical),
    currentNoteReadGeneration(userId, shortId),
  );
  if (orderingToken !== undefined && orderingToken !== generation) {
    // The returned Note is evidence for fencing, not authority to replace the
    // current pair or upgrade the request that produced it.
    noteGenerations.set(generationKey(userId, canonical), generation);
    return false;
  }
  for (const [key, value] of currentShortIds) {
    const [owner, id] = JSON.parse(key) as [string, string];
    if (owner === userId && (id === canonical || value === shortId)) {
      currentShortIds.delete(key);
    }
  }
  currentShortIds.set(generationKey(userId, canonical), shortId);
  noteGenerations.set(generationKey(userId, canonical), generation);
  noteGenerations.set(generationKey(userId, shortId), generation);
  return true;
}

export function currentNoteReadGeneration(
  userId: string,
  noteId: string,
): number {
  return (
    noteGenerations.get(generationKey(userId, noteId)) ??
    userClearGenerations.get(userId) ??
    0
  );
}

export function beginNoteReadOrder(userId: string, noteId: string): number {
  return currentNoteReadGeneration(userId, noteId);
}

export function enterNoteDenialOrder(userId: string, noteId: string): number {
  const generation = nextGeneration++;
  for (const id of noteIdentityIds(userId, noteId)) {
    noteGenerations.set(generationKey(userId, id), generation);
  }
  return generation;
}

export function clearUserNoteReadOrder(userId: string): void {
  userClearGenerations.set(userId, nextGeneration++);
  for (const key of currentShortIds.keys()) {
    if ((JSON.parse(key) as [string, string])[0] === userId) {
      currentShortIds.delete(key);
    }
  }
  for (const key of noteGenerations.keys()) {
    if (key.startsWith(`${JSON.stringify([userId]).slice(0, -1)},`)) {
      noteGenerations.delete(key);
    }
  }
}

export function isCurrentNoteReadOrder(
  userId: string,
  noteId: string,
  token: number,
): boolean {
  return currentNoteReadGeneration(userId, noteId) === token;
}
