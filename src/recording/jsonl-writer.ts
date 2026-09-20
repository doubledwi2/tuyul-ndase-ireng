import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type RecorderErrorHandler = (error: unknown) => void;

export class JsonlWriter {
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onError: RecorderErrorHandler,
  ) {}

  append(value: unknown): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(value)}\n`;
    } catch (error) {
      this.onError(error);
      return Promise.resolve();
    }

    const write = this.pendingWrites.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, 'utf8');
    });

    this.pendingWrites = write.catch((error: unknown) => {
      this.onError(error);
    });

    return this.pendingWrites;
  }

  flush(): Promise<void> {
    return this.pendingWrites;
  }
}
