// A check worker that cannot start: it throws while loading, as a missing or
// broken dependency would, before it ever says it is ready.

throw new Error('broken on purpose');
