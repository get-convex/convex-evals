import { appendFileSync } from 'fs';
import { join } from 'path';

export class Logger {
  constructor(private logPath: string) {}

  log(level: 'info' | 'debug' | 'step' | 'error', message: string, data?: object) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    console.log(line);
    if (data) console.log(JSON.stringify(data, null, 2));

    appendFileSync(this.logPath, line + '\n');
    if (data) appendFileSync(this.logPath, JSON.stringify(data, null, 2) + '\n');
  }

  info(message: string, data?: object) {
    this.log('info', message, data);
  }

  debug(message: string, data?: object) {
    this.log('debug', message, data);
  }

  step(message: string, data?: object) {
    this.log('step', message, data);
  }

  error(message: string, data?: object) {
    this.log('error', message, data);
  }
}
