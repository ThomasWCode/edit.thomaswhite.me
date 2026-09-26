// Unsaved edits, mirrored to sessionStorage per file so a reload, a sign-in
// round trip or a crashed tab does not lose typing. Each record keeps the blob
// SHA the edits started from; a different SHA on reload means the file changed
// on GitHub meanwhile, and the editor offers the old edits instead of applying
// them.

const PREFIX = "siteEditor.working.v1";

export function createWorkingStore({ storage, target }) {
  const scope = `${PREFIX}:${target.owner}/${target.repo}:`;
  const key = (path) => `${scope}${path}`;
  return {
    save(path, record) {
      try {
        storage.setItem(key(path), JSON.stringify(record));
        return true;
      } catch {
        return false;
      }
    },
    load(path) {
      try {
        const value = JSON.parse(storage.getItem(key(path)));
        return value && typeof value.working === "string" ? value : null;
      } catch {
        return null;
      }
    },
    remove(path) {
      try {
        storage.removeItem(key(path));
      } catch {
        // Storage unavailable: nothing to remove.
      }
    },
    paths() {
      const found = [];
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const name = storage.key(index);
          if (name && name.startsWith(scope)) found.push(name.slice(scope.length));
        }
      } catch {
        // Storage unavailable.
      }
      return found;
    },
  };
}
