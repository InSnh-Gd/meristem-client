type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

interface LogEntry {
  ts: number;
  level: LogLevel;
  node_id: string;
  source: string;
  content: string;
  meta?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50,
};

function resolveLevel(): LogLevel {
  const env = (process.env.MERISTEM_LOGGING_LEVEL || 'info').toUpperCase();
  if (env === 'DEBUG' || env === 'INFO' || env === 'WARN' || env === 'ERROR' || env === 'FATAL') {
    return env;
  }
  return 'INFO';
}

class Logger {
  private readonly minLevel = resolveLevel();
  private readonly nodeId = process.env.MERISTEM_NODE_ID || 'unknown';
  private readonly source = 'meristem-client';

  private log(level: LogLevel, content: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      ts: Date.now(),
      level,
      node_id: this.nodeId,
      source: this.source,
      content,
      meta,
    };

    console.log(JSON.stringify(entry));
  }

  debug(content: string, meta?: Record<string, unknown>): void {
    this.log('DEBUG', content, meta);
  }

  info(content: string, meta?: Record<string, unknown>): void {
    this.log('INFO', content, meta);
  }

  warn(content: string, meta?: Record<string, unknown>): void {
    this.log('WARN', content, meta);
  }

  error(content: string, meta?: Record<string, unknown>): void {
    this.log('ERROR', content, meta);
  }

  fatal(content: string, meta?: Record<string, unknown>): void {
    this.log('FATAL', content, meta);
  }
}

export const logger = new Logger();
