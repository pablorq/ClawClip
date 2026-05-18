import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Calculate a SHA-256 checksum for a directory or file.
 * For directories, it recursively hashes all files and their relative paths.
 */
export async function calculateSkillChecksum(rootPath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await updateHash(rootPath, "", hash);
  return hash.digest("hex");
}

async function updateHash(rootPath: string, relativePath: string, hash: crypto.Hash): Promise<void> {
  const fullPath = path.join(rootPath, relativePath);
  const stats = await fs.stat(fullPath);

  if (stats.isDirectory()) {
    const entries = await fs.readdir(fullPath);
    // Sort entries to ensure deterministic hashing across runs
    entries.sort();
    for (const entry of entries) {
      // Exclude hidden files and .checksum
      if (entry.startsWith(".") || entry === ".checksum") continue;
      await updateHash(rootPath, path.join(relativePath, entry), hash);
    }
  } else if (stats.isFile()) {
    // Add relative path and file content to hash
    hash.update(relativePath);
    const content = await fs.readFile(fullPath);
    hash.update(content);
  }
}
