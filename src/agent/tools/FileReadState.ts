export type FileReadSnapshot = {
  content: string;
  isPartialView?: boolean;
  limit?: number;
  offset?: number;
  path: string;
  timestampMs: number;
};

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export class FileReadState {
  private readonly entries = new Map<string, FileReadSnapshot>();

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  get(path: string): FileReadSnapshot | undefined {
    const normalized = this.normalize(path);
    const value = this.entries.get(normalized);
    if (!value) {
      return undefined;
    }
    this.entries.delete(normalized);
    this.entries.set(normalized, value);
    return value;
  }

  set(path: string, snapshot: Omit<FileReadSnapshot, "path">): void {
    const normalized = this.normalize(path);
    this.entries.set(normalized, { ...snapshot, path: normalized });
    this.prune();
  }

  private normalize(path: string): string {
    return path.replace(/\\/g, "/");
  }

  private prune(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes() > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      this.entries.delete(oldest);
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += Buffer.byteLength(entry.content);
    }
    return total;
  }
}
